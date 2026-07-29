-- ============================================================================
-- schema.sql — Pontmore custodial escrow (PIP-01 conformant)
--
-- Run this in the Supabase SQL editor. It creates the escrow_instances table,
-- indexes, and the atomic transition_escrow_state RPC used by the service.
--
-- Dispute fields and operator-layer columns are included for the operator UI
-- (PIP-03 dispute classes / resolution modes). These are operator-layer
-- overlays, not canonical public protocol state.
-- ============================================================================

create table if not exists public.escrow_instances (
    escrow_id                  uuid        primary key default gen_random_uuid(),
    state                      text        not null default 'CREATED',
    funding_model              text        not null default 'single_funder',
    creator_pubkey             text        not null,
    counterparty_pubkey        text,
    amount_sats                integer     not null check (amount_sats > 0),
    platform_fee_sats          integer     not null default 0 check (platform_fee_sats >= 0),
    description                text        not null default '',
    refund_ln_address          text,
    payout_ln_address          text,
    idempotency_key            text        unique,
    invitation_token           text        not null unique,
    blink_payment_hash         text,
    blink_payment_request      text,
    release_decision_type      text,
    release_decision_payload   jsonb,
    payout_successful          boolean     not null default false,
    -- operator-layer dispute columns (PIP-03)
    dispute_class              text,
    dispute_opened_by          text,
    dispute_opened_at          timestamptz,
    dispute_summary            text,
    dispute_resolution_mode    text,
    dispute_resolution_note    text,
    dispute_resolved_at        timestamptz,
    created_at                 timestamptz not null default now(),
    updated_at                 timestamptz not null default now()
);

-- Indexes for common query patterns
create index if not exists idx_escrow_state           on public.escrow_instances (state);
create index if not exists idx_escrow_creator         on public.escrow_instances (creator_pubkey);
create index if not exists idx_escrow_counterparty    on public.escrow_instances (counterparty_pubkey);
create index if not exists idx_escrow_dispute_class   on public.escrow_instances (dispute_class) where dispute_class is not null;

-- ============================================================================
-- Atomic state transition RPC
-- ============================================================================
-- Atomically transitions an escrow from p_expected_state to p_new_state.
-- Applies extra column updates passed in p_extra (jsonb) when provided.
-- Returns the updated row, or an empty set on state mismatch (caller
-- interprets empty as a StateConflictError).
-- ============================================================================

create or replace function public.transition_escrow_state(
    p_escrow_id       uuid,
    p_expected_state  text,
    p_new_state       text,
    p_extra           jsonb default '{}'::jsonb
) returns setof public.escrow_instances
language plpgsql
security definer
as $$
declare
    allowed_transitions text[][] := array[
        array['CREATED',          'PENDING_FUNDING'],
        array['CREATED',          'CANCELLED'],
        array['PENDING_FUNDING',  'PENDING_FUNDING'],   -- self-transition for invoice stamping
        array['PENDING_FUNDING',  'FUNDED'],
        array['PENDING_FUNDING',  'CANCELLED'],
        array['FUNDED',           'SETTLED'],
        array['FUNDED',           'DISPUTED'],
        array['FUNDED',           'CANCELLED'],
        array['DISPUTED',         'SETTLED'],
        array['DISPUTED',         'CANCELLED']
    ];
    is_valid boolean := false;
    now_ts timestamptz := now();
begin
    for i in 1..array_length(allowed_transitions, 1) loop
        if allowed_transitions[i][1] = p_expected_state
           and allowed_transitions[i][2] = p_new_state then
            is_valid := true;
            exit;
        end if;
    end loop;

    if not is_valid then
        raise exception 'Invalid state transition: % → %', p_expected_state, p_new_state;
    end if;

    return query
    update public.escrow_instances
       set state                   = p_new_state,
           updated_at              = now_ts,
           -- conditionally set dispute timestamps
           dispute_opened_at       = case when p_new_state = 'DISPUTED' then now_ts else dispute_opened_at end,
           dispute_resolved_at     = case when p_expected_state = 'DISPUTED' and p_new_state in ('SETTLED', 'CANCELLED') then now_ts else dispute_resolved_at end,
           -- apply p_extra columns (coalesce prefers explicit value, falls back to existing)
           blink_payment_hash      = coalesce((p_extra->>'blink_payment_hash')::text,       blink_payment_hash),
           blink_payment_request   = coalesce((p_extra->>'blink_payment_request')::text,    blink_payment_request),
           dispute_class           = coalesce((p_extra->>'dispute_class')::text,            dispute_class),
           dispute_opened_by       = coalesce((p_extra->>'dispute_opened_by')::text,        dispute_opened_by),
           dispute_summary         = coalesce((p_extra->>'dispute_summary')::text,          dispute_summary),
           dispute_resolution_mode = coalesce((p_extra->>'dispute_resolution_mode')::text,  dispute_resolution_mode),
           dispute_resolution_note = coalesce((p_extra->>'dispute_resolution_note')::text,  dispute_resolution_note)
    where escrow_id = p_escrow_id
      and state     = p_expected_state
    returning *;
end;
$$;

-- ============================================================================
-- updated_at auto-maintenance trigger
-- ============================================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists trg_escrow_updated_at on public.escrow_instances;
create trigger trg_escrow_updated_at
    before update on public.escrow_instances
    for each row
    execute function public.set_updated_at();
