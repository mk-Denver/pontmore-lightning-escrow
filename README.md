# Pontmore Escrow Service

A [PIP-01](https://github.com/pontmore) conformant **custodial escrow service** over HTTPS for the Bitcoin Lightning Network. It holds sats in custody until a verifiable release/refund decision is reached, then pays out to a Lightning address. Identity and authorization are provided by Nostr (NIP-98 HTTP auth).

The service is discoverable on the Nostr network via signed `kind 30361` escrow descriptor events, and on the [poc.pontmore.xyz](https://poc.pontmore.xyz) directory.

---

## Features

- **PIP-01 standalone service interface** — six canonical operations: `create`, `funding_instructions`, `fund_status`, `release`, `refund`, `cancel`.
- **Nostr-native auth (NIP-98)** — every mutating request carries a signed `kind 27235` auth event; the authenticated Nostr pubkey *is* the participant identity.
- **Three funding models**
  - `single_funder` — one invoice on the escrow row; the creator is the funder.
  - `two_party` — per-participant invoices in `escrow_funders`; funded only when both invoices are paid.
  - `m_of_n` — per-participant invoices; active once at least `funding_threshold` (M) of `participant_count` (N) funders have paid.
- **Five release-decision formats** (configurable subset per deployment):
  `mutual_consent`, `operator_decision`, `oracle_signature`, `application_signed_result`, `threshold_participant_signatures`.
- **Lightning custody via [Blink](https://blink.sv)** — invoice creation, payment status, and payouts to Lightning addresses / BOLT11.
- **Durable storage via [Supabase](https://supabase.com)** — Postgres with an atomic state-transition RPC.
- **Operator dashboard** — a static web UI plus protected endpoints to list escrows, file/resolve disputes, and publish/unpublish the descriptor.
- **Descriptor-only mode** — when Supabase/Blink credentials are blank, the service still serves the descriptor and OpenAPI schema (useful for discovery testing).

---

## Architecture

```
server.js                       Express app: public, protected, and operator routes
config/env.js                   Validated configuration + fee helpers
lib/
  escrow.js                     Core escrow operations (state machine orchestration)
  release-decisions.js          Schnorr verification of release/refund decisions
  nostr-auth.js                 NIP-98 auth middleware
  nostr-keys.js                 nsec / npub / hex key decoding
services/
  supabase.js                   Escrow + funder persistence, atomic state transitions
  blink.js                      Lightning invoice + payout integration
scripts/
  publish-descriptor.js         Build, sign & broadcast the kind 30361 descriptor
  curl-auth.js                  Generate a curl command with a signed NIP-98 header
public/
  descriptor.json               Static PIP-01 descriptor (rewritten at serve time)
  openapi.json                  Normative wire contract (schema_url target)
  operator/index.html           Operator dashboard UI
src/main.js                    Appwrite Functions adapter (alternative host)
schema.sql                      Postgres schema + transition_escrow_state RPC
```

### Escrow state machine

```
created ──► partially_funded ──► active ──► release_pending
   │                 │              │               │
   └──► canceled ◄───┘              ├──► released ◄─┤
                                    ├──► refunded ◄─┤
                                    └──► disputed ──┘
```

Transitions are enforced atomically by the `transition_escrow_state` Postgres RPC in `schema.sql`.

---

## Quick start

### Prerequisites

- Node.js ≥ 20
- A Supabase project (run `schema.sql` in the SQL editor)
- A Blink API key
- A Nostr operator key pair (nsec + npub)

### 1. Configure

```bash
cp .env.example .env
# then edit .env — see inline comments for each variable
```

Key variables:

| Variable | Description |
| --- | --- |
| `PORT` | Express listen port (default `3000`). |
| `SERVICE_BASE_URL` | Public base URL (no trailing slash). |
| `SERVICE_PATH_PREFIX` | HTTP interface prefix (default `/pontmore/v1`). |
| `FUNDING_MODEL` | Default funding model when a `create` omits it. |
| `ACCEPTED_FUNDING_MODELS` | Comma-separated subset this deployment accepts. |
| `ACCEPTED_RELEASE_DECISIONS` | Comma-separated subset of decision formats accepted. |
| `FUNDING_TIMEOUT_SECONDS` | Maximum funding phase before partial sides may be canceled and refunded. |
| `DECISION_MAX_AGE_SECONDS` | Maximum accepted release-decision age. |
| `ORACLE_PUBKEYS` | Trusted oracle identities when `oracle_signature` is advertised. |
| `OPERATOR_PUBKEY` / `OPERATOR_NSEC` | Operator Nostr identity (npub/hex and nsec). |
| `APPLICATION_SIGNER_PUBKEYS` | Pubkeys authorized for `application_signed_result` decisions. |
| `SUPABASE_PROJECT_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase backend. |
| `BLINK_API_KEY` | Blink Lightning custody key. |
| `PLATFORM_FEE_PERCENTAGE` | Decimal fee paid by the funder (e.g. `0.02` = 2%). |

### 2. Initialize the database

Run the contents of [`schema.sql`](schema.sql) in your Supabase SQL editor. This creates the `escrow_instances` and `escrow_funders` tables, indexes, and the `transition_escrow_state` RPC.

### 3. Install & run

```bash
npm install
npm start          # production
npm run dev        # auto-restart on changes via node --watch
```

The service prints its readiness, the descriptor URL, and confirms the backend is configured.

---

## API overview

All protected routes live under `SERVICE_PATH_PREFIX` (default `/pontmore/v1`) and require a NIP-98 `Authorization: Nostr <base64>` header. The auth event is `kind 27235` with `['u', <full URL>]` and `['method', <HTTP method>]` tags, and a `['payload', sha256(body)]` tag when a body is present.

### Public

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Liveness + backend status. |
| `GET` | `/pontmore/v1/descriptor` | The PIP-01 escrow descriptor (service block rewritten live). |
| `GET` | `/pontmore/v1/openapi/v1.0.0.json` | The immutable normative wire contract (`schema_url`). |

### Protected (NIP-98)

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `POST` | `/pontmore/v1/create` | New: `amount_sats`, `participant_pubkeys`, model fields. Join: `enrollment_token`. | Open an escrow or redeem a signer-bound enrollment. |
| `POST` | `/pontmore/v1/funding_instructions` | `escrow_id` | Return/create the Lightning invoice to fund. |
| `POST` | `/pontmore/v1/fund_status` | `escrow_id` | Observe funding state (per-funder for multi-party). |
| `POST` | `/pontmore/v1/release` | `escrow_id`, `release_decision`, `recipient`, `signatures`, `nonce`, `timestamp`, `result` | Release funds to the payee. |
| `POST` | `/pontmore/v1/refund` | same as release | Refund funds to the funder(s). |
| `POST` | `/pontmore/v1/cancel` | `escrow_id` | Cancel before funding, or after funding timeout with automatic partial refunds. |

### Operator (NIP-98 + `OPERATOR_PUBKEY`)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/pontmore/v1/operator/escrows` | List escrow instances (filter by `?state=`). |
| `GET` | `/pontmore/v1/operator/escrows/:id` | Detail for one escrow (internal payment fields stripped). |
| `POST` | `/pontmore/v1/operator/disputes` | File a dispute on an escrow. |
| `POST` | `/pontmore/v1/operator/disputes/:id/resolve` | Resolve a dispute and execute the payout. |
| `GET` | `/pontmore/v1/operator/descriptor` | The served descriptor (operator view). |
| `POST` | `/pontmore/v1/operator/publish` | Broadcast a signed `kind 30361` descriptor event to relays. |
| `POST` | `/pontmore/v1/operator/unpublish` | Broadcast a `kind 5` deletion event for descriptor event ids. |

A static dashboard is served at `/operator`.

---

## Release decisions

A release/refund request carries a `release_decision` type and Schnorr (`BIP-340`) signatures over a canonical message:

```
pontmore-escrow:v1:<escrow_id>:<action>:<recipient>:<result_hash>:<nonce>:<timestamp>
```

Supported formats:

- **`mutual_consent`** — signatures from all bound participants.
- **`operator_decision`** — a signature from the configured `OPERATOR_PUBKEY`.
- **`oracle_signature`** — a signature from an `oracle_pubkey` registered in `ORACLE_PUBKEYS`.
- **`application_signed_result`** — a signature from a configured `APPLICATION_SIGNER_PUBKEYS` entry, bound to a `result` payload.
- **`threshold_participant_signatures`** — at least `threshold` distinct participant signatures.

---

## Scripts

Generate an authenticated curl command (uses `OPERATOR_NSEC` from `.env`):

```bash
node scripts/curl-auth.js POST /pontmore/v1/create '{"amount_sats":1000,"description":"test"}'
```

Build, sign, and (optionally) broadcast the descriptor:

```bash
node scripts/publish-descriptor.js            # print the signed event
node scripts/publish-descriptor.js --publish   # broadcast to Nostr relays
# or: npm run publish
```

---

## Deployment

The service runs as a plain Express app (`node server.js`) on any Node host. An [Appwrite Functions](https://appwrite.io) adapter is also provided in `src/main.js` (see `appwrite.config.json`); the same Express `app` is bridged through the Appwrite request/response shape.

Set `SERVICE_BASE_URL` to the public URL of the deployment so the descriptor and OpenAPI server block are rewritten correctly. Cron jobs cancel funding-timeout escrows with partial refunds and recover pending release payouts. The service never auto-releases without a valid decision.

---

## License

See the repository for license information.
