# Building Pontmore: From Protocol Spec to Working Escrow POC

*August 2026*

When I opened [PR #12](https://github.com/pontmore/protocol/pull/12) on the Pontmore protocol repo, I was trying to answer one question: can we define a standard way for applications to invoke an escrow service directly, without routing through a swap state machine? The answer turned out to be yes — but the path from spec to working POC to simplified protocol taught me more than I expected about designing interoperable financial infrastructure.

## The Context: PIP-01 Before PR #12

PIP-01 (the Pontmore Escrow Descriptor) initially served a narrow purpose: it allowed agents to discover compatible escrow mechanisms for fiat-to-Bitcoin swaps. It was a discovery tool, not an execution engine.

A descriptor looked like this:

```json
{
  "version": 1,
  "escrow_type": "lightning_hold_invoice",
  "networks": ["bitcoin", "lightning"],
  "funding_rules": { "required_confirmation": "invoice_held" },
  "release_rules": {
    "release_trigger": "counterparty_fiat_payment_confirmed"
  },
  "dispute_rules": { "policy": "operator_resolved" }
}
```

This tells an agent "this escrow exists and it works with Lightning hold invoices." But it doesn't tell a standalone application how to create an escrow, fund it, release it, or cancel it. Those details were implicit in PIP-02's swap state machine — you needed a swap to use an escrow.

## PR #12: The Standalone Service Interface

The driving force was [Issue #11](https://github.com/pontmore/protocol/issues/11): "Define escrow service invocation in PIP-01." The proposal was deceptively simple: add an optional `service` block to the descriptor that tells applications how to talk to the escrow directly.

The resulting spec defined:

- **Transport**: `https` (canonical), with room for additional transports
- **Authentication**: `nostr_http_auth` (NIP-98) — your Nostr pubkey IS your identity
- **Canonical operations**: `create`, `funding_instructions`, `fund_status`, `release`, `refund`, `split`, `cancel`
- **Funding models**: `single_funder`, `two_party`, `m_of_n`
- **Release decisions**: `mutual_consent`, `operator_decision`, `oracle_signature`, `application_signed_result`, `threshold_participant_signatures`, `split_decision`
- **Wire contract**: a `schema_url` pointing to a normative OpenAPI document

A standalone-sufficient descriptor now looked like:

```json
{
  "version": 1,
  "escrow_type": "custodial_escrow",
  "networks": ["lightning"],
  "funding_rules": { "required_confirmation": "invoice_paid", "funding_timeout": "86400_seconds" },
  "release_rules": { "release_trigger": "application_signed_result", "refund_trigger": "timeout_or_dispute_refund_decision" },
  "dispute_rules": { "policy": "operator_resolved" },
  "service": {
    "transport": ["https"],
    "interface": "pontmore_escrow_http_v1",
    "endpoint": "https://escrow.example.com/pontmore/v1",
    "auth": ["nostr_http_auth"],
    "operations": ["create", "funding_instructions", "fund_status", "release", "refund", "cancel"],
    "funding_model": ["single_funder", "two_party", "m_of_n"],
    "release_decisions": ["mutual_consent", "operator_decision", "application_signed_result"],
    "schema_url": "https://escrow.example.com/pontmore/v1/openapi/v1.0.0.json"
  }
}
```

The PR also patched several structural loopholes:
- **Sybil-join fix**: enrollment tokens bound to exact pubkey at redemption
- **Cross-instance replay fix**: oracle/threshold signatures commit to stable escrow ID
- **Escrow state machine**: canonical states (`created` → `partially_funded` → `active` → `release_pending` → terminal)
- **Funding-phase timeout**: `cancel` in `partially_funded` must refund all funded sides
- **Deadlock fix**: non-mutual-consent fallback required for refund triggers
- **Implementation risks**: documented Lightning routing penalties, custodial counterparty risk, Cashu mint liveness

PR #12 was merged on August 11, 2026 — with review feedback that would prove significant.

## Review Feedback That Seeded PR #17

During review, [okjodom](https://github.com/okjodom) left several comments that hinted at a larger refactor:

> "We could simplify this definition by deferring the service, transport and interface version to the declared OpenAPI schema doc."

> "Please remove the escrow state machine definition. Implementation details must not be part of the generic PIP-01 spec."

> "I'm quite wary of having to define these operational semantics in the escrow descriptor."

There was a tension: PR #12 had made the descriptor the source of truth for service behavior, but the reviewer wanted to pull that behavior back into the referenced schema. He approved the PR anyway — "this has provably moved us forward by a margin, let's land and iterate" — and immediately opened [PR #17](https://github.com/pontmore/protocol/pull/17) to simplify the spec.

## The POC: Building Against PR #12

With the spec merged, I built a working implementation ([pontmore-lightning-escrow](https://github.com/mk-Denver/pontmore-lightning-escrow)) — a custodial escrow service running on Render with Blink Lightning custody and Supabase persistence. It's live at `standalone-escrow.onrender.com`.

### Architecture

```
                   Nostr Relays               HTTPS Clients
                  (nos.lol etc)           (rollpot, curl, apps)
                       │                         │
                       │ kind 30361              │ NIP-98 auth header
                       │ descriptor              │ (signed kind 27235 event)
                       ▼                         ▼
              ┌─────────────────────────────────────────┐
              │           Express Server                │
              │           (Render, port 3000)           │
              │                                        │
              │  ┌──────────────┐  ┌────────────────┐  │
              │  │  NIP-98 Auth │  │  Escrow Engine  │  │
              │  │  Middleware  │  │   + 5 release   │  │
              │  │              │  │  decision types │  │
              │  └──────────────┘  └───────┬────────┘  │
              │                           │            │
              │            ┌──────────────┼──────────┐ │
              │            │              │          │ │
              │            ▼              │          ▼ │
              │   ┌──────────────┐        │  ┌──────────────┐
              │   │   Supabase   │        │  │    Blink     │
              │   │   (Postgres) │        │  │  (Lightning) │
              │   │              │        │  │              │
              │   │ · escrow     │        │  │ · invoices   │
              │   │   instances  │        │  │ · payments   │
              │   │ · funders    │        │  │ · LN address │
              │   │ · state RPC  │        │  │   payouts    │
              │   └──────────────┘        │  └──────────────┘
              │                           │
              └───────────────────────────┼──────────────┘
                                          │
                           Schnorr (BIP-340) signing
                           canonical release message:
                           pontmore-escrow:v1:<id>:<action>:...
```

**Express Server** handles all PIP-01 operations via NIP-98 authenticated endpoints. Every request carries a signed Nostr event — the pubkey IS the identity.

**Escrow Engine** validates state transitions, verifies release/refund Schnorr signatures across 5 decision formats, manages enrollment tokens, and orchestrates multi-party funding. All state mutations go through a Postgres RPC that atomically checks the current state before transitioning.

**Supabase** provides durable Postgres storage with two tables (`escrow_instances`, `escrow_funders`) and a `transition_escrow_state` RPC that prevents race conditions.

**Blink** is the Lightning custody backend — creates BOLT11 invoices per participant, detects payments, and executes Lightning Address payouts on release. Payout idempotency is guaranteed via deterministic keys (`escrow-payout:<escrow_id>:<purpose>:<recipient_pubkey>`).

### Challenge 1: Open Enrollment

The creator doesn't need to know who the counterparty is upfront. The service issues opaque, single-use enrollment tokens:

```
Creator: POST /create { "amount_sats": 1000, "funding_model": "two_party" }
  → { "escrow_id": "...", "enrollments": [{ "enrollment_token": "tok_abc123..." }] }

Creator shares token out-of-band (QR, DM, URL)

Counterparty: POST /create { "enrollment_token": "tok_abc123..." }
  // NIP-98 header binds the joiner's pubkey at redemption
  → { "escrow_id": "...", "counterparty_pubkey": "<joiner's pubkey>" }
```

**Lesson:** Removing the pre-declared pubkey requirement transformed the UX from "negotiate, then create" to "create, then share." This is the difference between a protocol people use and one they don't.

### Challenge 2: Preventing Half-Joined Escrows

When a counterparty joins, two things must happen atomically: the escrow row gets updated, AND funder rows get created. If we updated the escrow first and funder seeding failed, the escrow was stuck — counterparty bound but no funder records.

**Fix:** Seed funder rows before updating the escrow. If seeding fails, the escrow is untouched and the token can be retried.

### Challenge 3: Idempotency and Race Conditions

Network retries are inevitable. When a client creates an escrow, loses the response, and retries with the same `idempotency_key`, the service must return the SAME escrow ID.

**Problem:** Idempotency keys lived forever, growing the deduplication table boundlessly.

**Fix:** Keys expire when the escrow reaches a terminal state OR the `funding_deadline` passes.

**Join races:** Two participants redeeming the same token simultaneously. Using `.single()` threw a 500 on zero rows. Fixed to `.maybeSingle()` with a clean 409 Conflict response.

### Challenge 4: Atomic State Machine

The escrow state machine is enforced by a Postgres RPC, not application code:

```sql
UPDATE escrow_instances
SET state = p_to_state
WHERE escrow_id = p_escrow_id AND state = p_from_state
RETURNING *;
```

If two requests race to transition, one succeeds and one gets zero rows. No distributed locks, no application-level mutexes — just a WHERE clause.

### Challenge 5: Multi-Party Accounting

For `two_party` and `m_of_n`:
- Each participant gets their own Lightning invoice (with individual platform fees)
- Release pays the sum of all FUNDED principal
- Refund pays each funder back their exact contribution
- `fund_status` exposes `total_funders`, `funded_count`, and `counterparty_pubkey` so clients can detect join/funding completion

### Challenge 6: Five Release Decision Formats

| Decision | Signer | Verification |
|---|---|---|
| `mutual_consent` | All bound participants | Every participant must sign |
| `operator_decision` | Service operator | Signature matches OPERATOR_PUBKEY |
| `oracle_signature` | Registered oracle | Oracle pubkey in ORACLE_PUBKEYS |
| `application_signed_result` | Any application | Any valid Schnorr sig + non-empty result |
| `threshold_participant_signatures` | ≥threshold participants | Count distinct valid participant sigs |

All signatures are over a canonical message that includes the `escrow_id`:

```
pontmore-escrow:v1:<escrow_id>:<action>:<recipient>:<result_hash>:<nonce>:<timestamp>
```

The `escrow_id` binding prevents replay across instances.

## The Test Suite

No automated tests existed. Manual curl commands were the only validation. I built a 50-test suite targeting the live Render deployment, covering descriptor discovery, NIP-98 auth (5 edge cases), open enrollment, funding, release decisions, cancel flow, idempotency, state machine correctness, and OpenAPI schema compliance. All tests use ephemeral secp256k1 keypairs with auto-cleanup.

I also built a separate tool — the [Escrow Descriptor Tester](https://github.com/mk-Denver/escrow-tester) — that queries Nostr relays for kind 30361 events, validates each against the PIP-01 spec (40+ checks), and runs live service tests against standalone endpoints. It found 18 descriptors on nos.lol, most of them `custodial_escrow` with `operator_resolved` dispute policy.

## PR #17: The Simplification

While the POC was running against the PR #12 spec, okjodom opened [PR #17](https://github.com/pontmore/protocol/pull/17) — a cleanup that recasts PIP-01 from a "descriptor-defined standalone service interface" into a "compatibility/discovery object with a schema pointer."

The key changes:

| Before (PR #12) | After (PR #17) |
|---|---|
| 10+ `service` fields: transport, interface, endpoint, auth, operations, funding_model, release_decisions, decision_signers, schema_url | One field: `service.schema{ type, url }` |
| Named funding models: single_funder, two_party, m_of_n | `funding_rules.funding_threshold` / `participant_count` cardinality |
| Descriptor-level `release_rules` with triggers and fallbacks | Removed — release behavior belongs to schema_url |
| Canonical state machine in PIP-01 | Removed — swapped to PIP-02, service behavior to schema |
| Subtype-specific field lists (implementations, custody_authority, etc.) | Trimmed to purpose, compatibility invariants, public/private boundary |

The new minimal descriptor (exactly as defined in the [upstream PR-17 spec](https://github.com/pontmore/protocol/blob/agent/simplify-pip01/PIP-01-escrow-descriptor.md)):

```json
{
  "version": 1,
  "escrow_type": "custodial_escrow",
  "networks": ["bitcoin", "lightning"],
  "funding_rules": {
    "funding_threshold": 1,
    "participant_count": 1,
    "required_confirmation": "invoice_paid",
    "funding_timeout": "funding timeout"
  },
  "dispute_rules": {
    "policy": "operator_resolved",
    "timeout_fallback": "operator_decision"
  },
  "reference_format": "bolt11_or_custodial_escrow_reference",
  "service": {
    "schema": {
      "type": "openapi",
      "url": "https://escrow.example.com/pontmore-escrow.openapi.json"
    }
  },
  "updated_at": 1775559028
}
```

The funding model is expressed as raw m-of-n cardinality:

- `funding_threshold` (m): the minimum number of funders whose payment must be confirmed
- `participant_count` (n): the total declared funding participants
- `1 of 1` = single-funder, `2 of 2` = two-party, `1 of 2` = one funding on behalf of two, other values = general threshold funding

No enum, no model name — just numbers. The schema_url defines how those numbers are enforced per-instance.

**The migration impact:** The live `standalone-escrow.onrender.com` deployment still serves the old PR #12 descriptor shape with named `funding_model` and a rich `service` block. Under PR #17, it should move to the cardinality-based descriptor with `service.schema` as the sole service field. The OpenAPI document already carries most of the behavior that PR #17 moves out of PIP-01: server URL, NIP-98 auth, operation paths, request/response schemas, state machine, idempotency, and operation-specific authorization rules. A follow-up should update schema wording that still references `descriptor service.funding_model` / `descriptor service.release_decisions`, since those are no longer descriptor fields.

Rollpot (the reference client) is directly affected. It currently derives the endpoint from `descriptor.service.endpoint` and infers two-party support from `descriptor.service.funding_model`. After PR #17, it should fetch `service.schema.url`, validate the referenced OpenAPI document, read `servers`, `paths`, security schemes, and extension metadata, then use the discovered service contract.

**The funding_model design tension:** The upstream spec defines funding as a single m-of-n cardinality — one fixed pair of numbers in the descriptor. This represents the maximum capability the escrow configuration declares. But the OpenAPI schema may still define a `funding_model` enum with multiple values (`single_funder`, `two_party`, `m_of_n`) and accept per-instance `funding_threshold` and `participant_count` at create time. The descriptor's cardinality serves as a compatibility claim — "this escrow can satisfy up to this funding requirement" — while the schema defines the full range of per-instance options. If an operator only supports two-party escrows, their descriptor says `funding_threshold: 2, participant_count: 2` and their schema reflects that constraint.

On our implementation branch ([`feat/pip01-pr17-simplify`](https://github.com/mk-Denver/pontmore-lightning-escrow/pull/11)), we use a `funding_model` array as a pragmatic bridge — it lets the operator configure exactly which models they support via `ACCEPTED_FUNDING_MODELS`, and the descriptor reflects that at serve time. This diverges from the strict upstream cardinality approach but solves the real-world deployment flexibility need. The upstream open question #2 — "what additional descriptor-level metadata is needed for clients to reject unsafe multi-party funding before fetching the service schema?" — acknowledges this tension is unresolved.

## What We Learned

**Protocol design is iterative.** The spec went from discovery-only (pre-PR #12) to rich service interface (PR #12) to minimal compatibility object (PR #17). Building while the spec evolves means accepting that some code will be thrown away — but the discarded code teaches you what the protocol actually needs. Every field we removed from the descriptor was a field we learned didn't belong there.

**The descriptor is a commitment, not documentation.** Publishing a kind 30361 event on Nostr relays is a public declaration. Changing the descriptor means broadcasting a deletion event and republishing. This creates healthy pressure to get the descriptor right before publishing — and makes it a useful signal for clients who want to know if an operator keeps their promises.

**Open enrollment changes everything.** Removing pre-declared pubkeys transformed the UX from "negotiate, then create" to "create, then share."

**Test against the live deployment.** Tests hitting the actual Render endpoint caught real behavioral differences: 200 vs 201 status codes, field presence in edge cases, and timeout behaviors that unit tests against mocks would miss.

**Multi-party accounting is harder than it looks.** Per-participant invoices, per-funder status, aggregate payout calculation, partial refunds on cancellation — these edge cases multiply with each additional participant. A separate `escrow_funders` table was essential; cramming everything into the escrow row would have been a mess.

**The public/private boundary matters.** Wallet IDs, custody backend identifiers, API keys, bearer secrets — none of these belong in the descriptor. PR #17 enforces this by making the descriptor a compatibility object, not a service contract. The schema_url is where implementation details live.

## What's Next

1. **Merge PR #17** — land the simplification and update the live descriptor
2. **Update rollpot** — migrate from descriptor-level endpoint discovery to OpenAPI-based service discovery
3. **Non-custodial escrow types** — Cashu P2PK timelock (`cashu_escrow`) has a spec but no implementation yet
4. **Nostr-native transport** — NIP-46-style relay-based RPC alongside HTTPS
5. **Tranche/milestone funding** — releasing escrowed amounts in installments for freelance contracts
6. **Cross-service interop** — multiple operators with compatible descriptors, enabling client-side trust model selection

---

*The POC: [github.com/mk-Denver/pontmore-lightning-escrow](https://github.com/mk-Denver/pontmore-lightning-escrow)*  
*The tester: [github.com/mk-Denver/escrow-tester](https://github.com/mk-Denver/escrow-tester)*  
*The protocol: [github.com/pontmore/protocol](https://github.com/pontmore/protocol)*  
*PR #12 (merged): [pontmore/protocol#12](https://github.com/pontmore/protocol/pull/12)*  
*PR #17 (simplification): [pontmore/protocol#17](https://github.com/pontmore/protocol/pull/17)*  
*Design discussion: [Open Bitcoin Africa](https://openbitcoin.africa/t/designing-standalone-escrows-in-pontmore-pip-01/28)*