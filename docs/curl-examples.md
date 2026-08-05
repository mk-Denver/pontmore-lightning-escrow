# Escrow API — curl examples

Base URL: `https://standalone-escrow.onrender.com`
API prefix: `/pontmore/v1`

All protected endpoints require a **NIP-98** `Authorization: Nostr <base64 JSON event>` header. The easiest way to produce a ready-to-run curl command with a valid signed header is the bundled helper:

```bash
node scripts/curl-auth.js <METHOD> <PATH> [JSON-BODY]
```

It reads `OPERATOR_NSEC` from `.env`, builds the `kind 27235` event, signs it, and prints a complete `curl` command. Copy-paste the output into your shell.

Below are the canonical flows. Replace `<ESCROW_ID>` with the UUID returned by `create`, and values in the auth header are illustrative — always generate the real one with `curl-auth.js` (or a NIP-07 client).

---

## 0. Discover the service (no auth)

### Descriptor
```bash
curl -s https://standalone-escrow.onrender.com/pontmore/v1/descriptor | jq
```

### OpenAPI schema
```bash
curl -s https://standalone-escrow.onrender.com/pontmore/v1/openapi.json | jq
```

### Health
```bash
curl -s https://standalone-escrow.onrender.com/health | jq
```

---

## 1. Generate a signed curl command

```bash
# Example: create a 1000-sat escrow
node scripts/curl-auth.js POST /pontmore/v1/create '{"amount_sats":1000,"description":"test escrow","refund_ln_address":"merchant@blink.sv"}'
```

Output looks like:

```
curl -s \
  -X 'POST' \
  -H 'Authorization: Nostr <base64-signed-event>' \
  -H 'Content-Type: application/json' \
  -d '{"amount_sats":1000,...}' \
  'https://standalone-escrow.onrender.com/pontmore/v1/create'
```

---

## 2. Create an escrow instance

```bash
curl -s -X POST https://standalone-escrow.onrender.com/pontmore/v1/create \
  -H 'Authorization: Nostr <base64-signed-event>' \
  -H 'Content-Type: application/json' \
  -d '{
    "amount_sats": 1000,
    "description": "Sale of digital goods #42",
    "refund_ln_address": "buyer@blink.sv"
  }' | jq
```

Response includes `escrow_id`, `funding_deadline`, and signer-bound `enrollments`.

### Create with two_party model
```bash
... -d '{"amount_sats":1000,"description":"two-party","funding_model":"two_party"}'
```

### Create with m_of_n (3 of 5)
```bash
... -d '{"amount_sats":1000,"description":"group buy","funding_model":"m_of_n","funding_threshold":3,"participant_count":5,"participant_pubkeys":["<PUBKEY_B>","<PUBKEY_C>","<PUBKEY_D>","<PUBKEY_E>"]}'
```

### Join an existing instance by invitation (counterparty)
```bash
... -d '{"enrollment_token":"<BOUND_ENROLLMENT_TOKEN>","refund_ln_address":"seller@blink.sv"}'
```

---

## 3. Get funding instructions (BOLT11 invoice)

```bash
curl -s -X POST https://standalone-escrow.onrender.com/pontmore/v1/funding_instructions \
  -H 'Authorization: Nostr <base64-signed-event>' \
  -H 'Content-Type: application/json' \
  -d '{"escrow_id":"<ESCROW_ID>"}' | jq
```

Response includes `payment_request` (the BOLT11 invoice). Pay it from any Lightning wallet. The amount equals `amount_sats + platform_fee_sats`.

---

## 4. Check funding status

```bash
curl -s -X POST https://standalone-escrow.onrender.com/pontmore/v1/fund_status \
  -H 'Authorization: Nostr <base64-signed-event>' \
  -H 'Content-Type: application/json' \
  -d '{"escrow_id":"<ESCROW_ID>"}' | jq
```

`state` becomes `active` once the funding condition is satisfied. Before that, funded multi-party instances are `partially_funded`.

---

## 5. Release funds to the payee

The `release` and `refund` endpoints require a **release decision**: a BIP-340 Schnorr signature over the canonical message

```
pontmore-escrow:v1:<escrow_id>:release:counterparty:<result_hash>:<nonce>:<timestamp>
```

### 5a. operator_decision release

```bash
curl -s -X POST https://standalone-escrow.onrender.com/pontmore/v1/release \
  -H 'Authorization: Nostr <base64-signed-event>' \
  -H 'Content-Type: application/json' \
  -d '{
    "escrow_id": "<ESCROW_ID>",
    "decision": {
      "release_decision": "operator_decision",
      "recipient": "counterparty",
      "nonce": "unique-nonce-1",
      "timestamp": 1699999999,
      "signatures": [
        { "pubkey": "<OPERATOR_PUBKEY_HEX>", "signature": "<SCHNORR_SIG_HEX>" }
      ]
    }
  }' | jq
```

### 5b. application_signed_result release

```bash
... -d '{
  "escrow_id": "<ESCROW_ID>",
  "decision": {
    "release_decision": "application_signed_result",
    "recipient": "counterparty",
    "nonce": "unique-nonce-2",
    "timestamp": 1699999999,
    "result": { "order_id": "42", "status": "delivered" },
    "signatures": [
      { "pubkey": "<APP_SIGNER_PUBKEY_HEX>", "signature": "<SCHNORR_SIG_HEX>" }
    ]
  }
}'
```

### 5c. mutual_consent release (both participants sign)

```bash
... -d '{
  "escrow_id": "<ESCROW_ID>",
  "decision": {
    "release_decision": "mutual_consent",
    "recipient": "counterparty",
    "nonce": "unique-nonce-3",
    "timestamp": 1699999999,
    "signatures": [
      { "pubkey": "<CREATOR_PUBKEY_HEX>",   "signature": "<CREATOR_SIG_HEX>" },
      { "pubkey": "<COUNTERPARTY_PUBKEY_HEX>", "signature": "<COUNTERPARTY_SIG_HEX>" }
    ]
  }
}'
```

---

## 6. Refund funds to the funder

`recipient` must be `creator`. Canonical action is `refund`.

```bash
curl -s -X POST https://standalone-escrow.onrender.com/pontmore/v1/refund \
  -H 'Authorization: Nostr <base64-signed-event>' \
  -H 'Content-Type: application/json' \
  -d '{
    "escrow_id": "<ESCROW_ID>",
    "decision": {
      "release_decision": "operator_decision",
      "recipient": "creator",
      "nonce": "unique-nonce-4",
      "timestamp": 1699999999,
      "signatures": [
        { "pubkey": "<OPERATOR_PUBKEY_HEX>", "signature": "<SCHNORR_SIG_HEX>" }
      ]
    }
  }' | jq
```

---

## 7. Cancel an unfunded escrow

Works in `created`, or in `partially_funded` after `funding_deadline`; funded sides are refunded before cancellation.

```bash
curl -s -X POST https://standalone-escrow.onrender.com/pontmore/v1/cancel \
  -H 'Authorization: Nostr <base64-signed-event>' \
  -H 'Content-Type: application/json' \
  -d '{"escrow_id":"<ESCROW_ID>"}' | jq
```

---

## 8. Operator endpoints (require `OPERATOR_PUBKEY`)

### List escrows
```bash
curl -s https://standalone-escrow.onrender.com/pontmore/v1/operator/escrows \
  -H 'Authorization: Nostr <base64-signed-event>' | jq

# filter by state
curl -s 'https://standalone-escrow.onrender.com/pontmore/v1/operator/escrows?state=active' \
  -H 'Authorization: Nostr <base64-signed-event>' | jq
```

### Get one escrow
```bash
curl -s https://standalone-escrow.onrender.com/pontmore/v1/operator/escrows/<ESCROW_ID> \
  -H 'Authorization: Nostr <base64-signed-event>' | jq
```

### File a dispute
```bash
curl -s -X POST https://standalone-escrow.onrender.com/pontmore/v1/operator/disputes \
  -H 'Authorization: Nostr <base64-signed-event>' \
  -H 'Content-Type: application/json' \
  -d '{
    "escrow_id": "<ESCROW_ID>",
    "dispute_class": "payout_not_sent",
    "summary": "Customer paid but no payout received"
  }' | jq
```

Valid `dispute_class` values: `payment_not_received`, `payment_amount_mismatch`, `payout_not_sent`, `payout_amount_mismatch`, `escrow_funding_failure`, `conflicting_external_confirmations`, `fraud_or_impersonation_risk`, `timeout_and_abandonment`.

### Resolve a dispute
```bash
curl -s -X POST https://standalone-escrow.onrender.com/pontmore/v1/operator/disputes/<ESCROW_ID>/resolve \
  -H 'Authorization: Nostr <base64-signed-event>' \
  -H 'Content-Type: application/json' \
  -d '{
    "outcome": "release",
    "resolution_mode": "confirm_customer_claim",
    "note": "Verified payment receipt from buyer"
  }' | jq
```

`outcome`: `release` | `refund`.
`resolution_mode`: `confirm_customer_claim`, `confirm_agent_claim`, `split_outcome`, `cancel_and_refund`, `escalate_manual_review`.

### Publish descriptor to Nostr
```bash
curl -s -X POST https://standalone-escrow.onrender.com/pontmore/v1/operator/publish \
  -H 'Authorization: Nostr <base64-signed-event>' \
  -H 'Content-Type: application/json' \
  -d '{"event":<SIGNED_KIND_30361_EVENT_OBJECT>}' | jq
```

### Unpublish (delete listing)
```bash
curl -s -X POST https://standalone-escrow.onrender.com/pontmore/v1/operator/unpublish \
  -H 'Authorization: Nostr <base64-signed-event>' \
  -H 'Content-Type: application/json' \
  -d '{"event_ids":["<64-hex-event-id>"]}' | jq
```

---

## Tip: pipe through `jq`

Install `jq` to pretty-print JSON:
```bash
brew install jq   # macOS
```

All examples above end with `| jq` for readable output. Drop it if `jq` is unavailable.
