# Pontmore Escrow Service

A [PIP-01](https://github.com/pontmore/protocol) conformant **custodial escrow service** over HTTPS for the Bitcoin Lightning Network. It holds sats in custody until a verifiable release/refund decision is reached, then pays out to a Lightning address. Identity and authorization are provided by Nostr (NIP-98 HTTP auth).

The service is discoverable on the Nostr network via signed `kind 30361` escrow descriptor events per [PIP-01](https://github.com/pontmore/protocol/blob/main/PIP-01-escrow-descriptor.md) (compatibility/discovery object — service behavior is defined by the referenced `service.schema`).

It also implements **[PIP-02](https://github.com/pontmore/protocol/blob/main/PIP-02-coordination-event-chains.md) coordination event chains** — immutable coordination roots (Nostr kind 7300) and append-only linked actions (kind 7301) — with the `pontmore/swap@1` bilateral fiat/Bitcoin swap profile.

---

## Conformance Profiles

| Profile | PIPs | Status |
|---|---|---|
| **Escrow Discovery** | PIP-01 | Implemented — descriptor publishing, validation, and serving |
| **Swap Coordination** | PIP-01 + PIP-02 + `pontmore/swap@1` | Implemented (experimental) — coordination root/action submission, chain validation, state derivation |

---

## Features

- **PIP-01 conformant descriptor** — the descriptor declares `version`, `escrow_type`, `networks`, `expires_at`, and a `service.schema` pointer (OpenAPI). All service behavior (funding, release, disputes, fees) is owned by the referenced schema. Published as signed `kind 30361` Nostr events with `t` tags matching `content.networks`.
- **PIP-02 coordination chains** — submit and validate coordination roots (kind 7300) and actions (kind 7301). Chain replay, kernel invariants, fork detection, and dispute handling per the PIP-02 kernel.
- **`pontmore/swap@1` profile** — bilateral fiat/Bitcoin swap: direction, fiat/bitcoin terms, deadlines, `swap/fiat_sent` / `swap/fiat_confirmed` actions, dispute classes, and authorization rules.
- **Nostr-native auth (NIP-98)** — every mutating request carries a signed `kind 27235` auth event; the authenticated Nostr pubkey *is* the participant identity.
- **Two two-party funding models** (PIP-01 `m of n` with `n = 2`)
  - `1_of_2` — one of the two declared funders must fund; the escrow activates on either payment.
  - `2_of_2` — both declared funders must fund; the escrow activates only when both invoices are paid.
- **Open enrollment** — `create` issues opaque single-use enrollment tokens; no pre-declared participant pubkeys required. The joining NIP-98 signer is bound to the token at redemption.
- **Five release-decision formats** (configurable subset per deployment):
  `mutual_consent`, `operator_decision`, `oracle_signature`, `application_signed_result`, `threshold_participant_signatures`.
  `application_signed_result` is bound to a per-instance `application_pubkey` pinned at creation.
- **Lightning custody via [Blink](https://blink.sv)** — invoice creation, payment status, and payouts to Lightning addresses.
- **Durable storage via [Supabase](https://supabase.com)** — Postgres with atomic state-transition RPCs.
- **Operator dashboard** — a static web UI plus protected endpoints to list escrows, file/resolve disputes, and publish/unpublish the descriptor.
- **Descriptor-only mode** — when Supabase/Blink credentials are blank, the service still serves the descriptor and OpenAPI schema (useful for discovery testing).

---

## Architecture

```
server.js                       Express app: public, protected, operator, and PIP-02 coordination routes
config/env.js                   Validated configuration + fee helpers
lib/
  escrow.js                     Core escrow operations (state machine orchestration)
  release-decisions.js          Schnorr verification of release/refund decisions
  nostr-auth.js                 NIP-98 auth middleware
  nostr-keys.js                 nsec / npub / hex key decoding
  nostr-event.js                Nostr event sign/verify helpers (PIP-01 + PIP-02)
  pip01.js                      PIP-01 descriptor event validation
  pip02.js                       PIP-02 coordination chain engine (kernel)
  swap-profile.js               pontmore/swap@1 coordination profile
services/
  supabase.js                   Escrow + funder persistence, atomic state transitions
  coordination.js              PIP-02 coordination root/action storage + chain replay
  blink.js                      Lightning invoice + payout integration
scripts/
  publish-descriptor.js         Build, sign & broadcast the kind 30361 descriptor
  list-descriptors.js           List published descriptor events; optionally delete them
  curl-auth.js                  Generate a curl command with a signed NIP-98 header
public/
  descriptor.json               Static PIP-01 descriptor (rewritten at serve time)
  openapi.json                  Normative wire contract (schema_url target)
  operator/index.html           Operator dashboard UI
src/main.js                    Appwrite Functions adapter (alternative host)
schema.sql                      Postgres schema + transition RPCs + PIP-02 coordination tables
```

### Escrow state machine

```
created ──► partially_funded ──► active ──► release_pending
   │                 │              │               │
   └──► canceled ◄───┘              ├──► released    ├──► released
                                    ├──► refunded    ├──► refunded
                                    └──► disputed    └──► disputed
                                          │
                                          ├──► released
                                          └──► refunded
```

Transitions are enforced atomically by the `transition_escrow_state` Postgres RPC in `schema.sql`. `release_pending` cannot transition to `canceled` — a valid signed refund decision is required once an escrow has been funded.

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
| `ACCEPTED_FUNDING_MODELS` | Comma-separated subset of `1_of_2`, `2_of_2` this deployment accepts. |
| `ACCEPTED_RELEASE_DECISIONS` | Comma-separated subset of decision formats accepted. |
| `FUNDING_TIMEOUT_SECONDS` | Maximum funding phase before partial sides may be canceled and refunded. |
| `DECISION_MAX_AGE_SECONDS` | Maximum accepted release-decision age. |
| `ORACLE_PUBKEYS` | Trusted oracle identities when `oracle_signature` is advertised. |
| `OPERATOR_PUBKEY` / `OPERATOR_NSEC` | Operator Nostr identity (npub/hex and nsec). |
| `APPLICATION_SIGNER_PUBKEYS` | Legacy deployment metadata. `application_signed_result` is now bound to the per-instance `application_pubkey` set at creation, not a service-wide allowlist. |
| `SUPABASE_PROJECT_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase backend. |
| `BLINK_API_KEY` | Blink Lightning custody key. |
| `PLATFORM_FEE_PERCENTAGE` | Decimal fee paid by the funder (e.g. `0.02` = 2%). |
| `ROUTING_FEE_SATS` | Flat routing fee in sats, deducted upfront from each payout/refund so the operator does not front the Lightning routing cost (e.g. `14` = 14 sats per payout). `0` disables it. |

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
| `GET` | `/pontmore/v1/descriptor` | The PIP-01 escrow descriptor (`service.schema.url` rewritten live). |
| `GET` | `/pontmore/v1/openapi/v1.0.0.json` | The immutable normative wire contract (`schema_url`). |

### Protected (NIP-98)

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `POST` | `/pontmore/v1/create` | New: `amount_sats`, required `funding_model` (`1_of_2` or `2_of_2`). Join: `enrollment_token`; the joining NIP-98 signer is bound at redemption. | Open an escrow or redeem an enrollment. |
| `POST` | `/pontmore/v1/funding_instructions` | `escrow_id` | Return/create the Lightning invoice to fund. |
| `POST` | `/pontmore/v1/fund_status` | `escrow_id` | Observe funding state (per-funder for multi-party). |
| `POST` | `/pontmore/v1/release` | `escrow_id`, `release_decision`, `recipient`, `signatures`, `nonce`, `timestamp`, `result` | Release funds to the payee. |
| `POST` | `/pontmore/v1/refund` | same as release | Refund funds to the funder(s). |
| `POST` | `/pontmore/v1/cancel` | `escrow_id` | Cancel before funding, or after funding timeout with automatic partial refunds. |
| `POST` | `/pontmore/v1/disputes` | `escrow_id`, `dispute_class`, `summary` | Raise a dispute. Caller must be a bound participant of the escrow (NIP-98 confirmed). Moves `active`/`release_pending` → `disputed`; the operator resolves under PIP-03. |

### PIP-02 Coordination (NIP-98)

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `POST` | `/pontmore/v1/coordination/root` | `{ event: <kind 7300 Nostr event> }` | Submit a signed coordination root. Validates against `pontmore/swap@1`, stores it, returns the coordination id. |
| `POST` | `/pontmore/v1/coordination/action` | `{ event: <kind 7301 Nostr event> }` | Submit a signed coordination action. Validates linkage, authorization, and kernel invariants; re-derives state. |
| `GET` | `/pontmore/v1/coordination/:coordinationId` | — | Retrieve the derived coordination state by replaying the full chain. |

### Operator (NIP-98 + `OPERATOR_PUBKEY`)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/pontmore/v1/operator/escrows` | List escrow instances (filter by `?state=`). |
| `GET` | `/pontmore/v1/operator/escrows/:id` | Detail for one escrow (internal payment fields stripped). |
| `POST` | `/pontmore/v1/operator/disputes` | File a dispute on an escrow. |
| `POST` | `/pontmore/v1/operator/disputes/:id/resolve` | Resolve a dispute and execute the payout. |
| `POST` | `/pontmore/v1/operator/escrows/:id/cancel` | Cancel an expired/abandoned escrow with automatic refunds. |
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
- **`application_signed_result`** — a valid Schnorr signature over the canonical message with a non-empty `result` payload. Any hex pubkey is accepted (no preconfigured allowlist); the signer is recorded in the decision payload.
- **`threshold_participant_signatures`** — at least `threshold` distinct participant signatures.

The descriptor advertises a `service.schema` pointer to the normative wire contract. Release, refund, and state-transition details are defined by the referenced OpenAPI schema, not repeated in the descriptor.

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

List published descriptor events and optionally delete them:

```bash
node scripts/list-descriptors.js            # list event ids
node scripts/list-descriptors.js --delete   # list + broadcast kind 5 deletion
```

## License

See the repository for license information.
