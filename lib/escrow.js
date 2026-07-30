'use strict';

/**
 * lib/escrow.js
 *
 * Core escrow instance operations for a PIP-01 custodial escrow service.
 * Each operation maps to one of the canonical service.operations vocabulary:
 * create, funding_instructions, fund_status, release, refund, cancel.
 *
 * Supports three funding models:
 *   - single_funder: one invoice on the escrow row, creator is the funder.
 *   - two_party:      per-participant invoices in escrow_funders; escrow is
 *                     FUNDED only when both funder invoices are paid.
 *   - n_of_m:         per-participant invoices in escrow_funders; escrow is
 *                     FUNDED when at least funding_threshold funders have paid.
 *
 * Participant identity is the authenticated Nostr pubkey (hex) from NIP-98.
 */

const { config, calculatePlatformFee } = require('../config/env');
const { isHexPubkey } = require('./nostr-auth');
const { verifyDecision } = require('./release-decisions');

const {
  StateConflictError,
  NotFoundError,
  ValidationError,
  createEscrowInstance,
  getEscrowInstance,
  joinEscrowInstance,
  setFundingInvoice,
  transitionState,
  setReleaseDecision,
  setPayoutSuccessful,
  getFunderRow,
  setFunderInvoice,
  setFunderFunded,
  listFunders,
  getFunderStats,
} = require('../services/supabase');

const {
  createLightningInvoice,
  getInvoiceStatus,
  payToLightningAddress,
  payBolt11Invoice,
  LnAddressPayoutError,
} = require('../services/blink');

// ─────────────────────────────────────────────────────────────────────────────
// create — open a new escrow instance and bind the creator pubkey
// ─────────────────────────────────────────────────────────────────────────────

async function create({ authPubkey, amountSats, description, refundLnAddress, idempotencyKey, invitationToken }) {
  if (!isHexPubkey(authPubkey)) throw new ValidationError('authenticated pubkey is not valid');
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    throw new ValidationError('amount_sats must be a positive integer');
  }
  if (description && (description.length < 1 || description.length > 500)) {
    throw new ValidationError('description must be 1–500 characters');
  }

  // Invitation join path: a counterparty joins an existing instance.
  if (invitationToken) {
    return joinByInvitation({ authPubkey, invitationToken, payoutLnAddress: refundLnAddress });
  }

  const platformFeeSats = calculatePlatformFee(amountSats);

  const model = config.FUNDING_MODEL;
  let fundingThreshold = null;
  let participantCount = null;

  if (model === 'two_party') {
    fundingThreshold = 2;
    participantCount = 2;
  } else if (model === 'n_of_m') {
    fundingThreshold = config.FUNDING_THRESHOLD;
    participantCount = config.PARTICIPANT_COUNT;
  }

  const escrow = await createEscrowInstance({
    creatorPubkey:    authPubkey,
    amountSats,
    platformFeeSats,
    description:      description ?? '',
    fundingModel:     model,
    fundingThreshold,
    participantCount,
    refundLnAddress:  refundLnAddress ?? null,
    idempotencyKey,
  });

  return {
    escrow_id:           escrow.escrow_id,
    state:               escrow.state,
    creator_pubkey:      escrow.creator_pubkey,
    amount_sats:         escrow.amount_sats,
    platform_fee_sats:   escrow.platform_fee_sats,
    funding_model:       escrow.funding_model,
    funding_threshold:   escrow.funding_threshold ?? null,
    participant_count:   escrow.participant_count ?? null,
    invitation_token:    escrow.invitation_token,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// join — counterparty enrolls using a service-issued invitation token
// ─────────────────────────────────────────────────────────────────────────────

async function joinByInvitation({ authPubkey, invitationToken, payoutLnAddress }) {
  const db = require('../services/supabase').supabase();
  const { data: existing, error } = await db
    .from('escrow_instances')
    .select('*')
    .eq('invitation_token', invitationToken)
    .maybeSingle();
  if (error) throw new Error(`[escrow] invitation lookup failed: ${error.message}`);
  if (!existing) throw new NotFoundError('Escrow instance (by invitation)', invitationToken);

  const updated = await joinEscrowInstance(existing.escrow_id, invitationToken, authPubkey, payoutLnAddress);
  return {
    escrow_id:              updated.escrow_id,
    state:                  updated.state,
    creator_pubkey:         updated.creator_pubkey,
    counterparty_pubkey:    updated.counterparty_pubkey,
    amount_sats:            updated.amount_sats,
    platform_fee_sats:      updated.platform_fee_sats,
    funding_model:          updated.funding_model,
    funding_threshold:      updated.funding_threshold ?? null,
    participant_count:      updated.participant_count ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// funding_instructions — create (or return) the Lightning invoice to fund
// ─────────────────────────────────────────────────────────────────────────────

async function fundingInstructions({ escrowId, authPubkey }) {
  const escrow = await getEscrowInstance(escrowId);
  requireParticipant(escrow, authPubkey);

  if (escrow.state === 'FUNDED' || escrow.state === 'SETTLED') {
    throw new ValidationError(`escrow is already ${escrow.state}; no funding instructions available`);
  }
  if (!['CREATED', 'PENDING_FUNDING'].includes(escrow.state)) {
    throw new ValidationError(`escrow is ${escrow.state}; cannot generate funding instructions`);
  }

  const model = escrow.funding_model;

  // single_funder: one invoice stamped on the escrow row.
  if (model === 'single_funder') {
    if (escrow.blink_payment_request) {
      return {
        escrow_id:        escrow.escrow_id,
        payment_hash:    escrow.blink_payment_hash,
        payment_request: escrow.blink_payment_request,
        amount_sats:     escrow.amount_sats + escrow.platform_fee_sats,
        funding_model:   'single_funder',
      };
    }

    const invoiceAmount = escrow.amount_sats + escrow.platform_fee_sats;
    const { paymentHash, paymentRequest } = await createLightningInvoice({
      amountSats: invoiceAmount,
      memo:       `Pontmore escrow ${escrow.escrow_id}`,
    });

    await setFundingInvoice(escrow.escrow_id, paymentHash, paymentRequest);

    return {
      escrow_id:        escrow.escrow_id,
      payment_hash:    paymentHash,
      payment_request: paymentRequest,
      amount_sats:     invoiceAmount,
      funding_model:   'single_funder',
    };
  }

  // two_party / n_of_m: per-funder invoices.
  let funder = await getFunderRow(escrowId, authPubkey);
  if (!funder) {
    throw new ValidationError('authenticated pubkey is not a registered funder for this escrow');
  }

  if (funder.blink_payment_request) {
    return {
      escrow_id:        escrow.escrow_id,
      funder_pubkey:    authPubkey,
      payment_hash:    funder.blink_payment_hash,
      payment_request: funder.blink_payment_request,
      amount_sats:      funder.amount_sats + funder.platform_fee_sats,
      funding_model:   model,
    };
  }

  const invoiceAmount = funder.amount_sats + funder.platform_fee_sats;
  const { paymentHash, paymentRequest } = await createLightningInvoice({
    amountSats: invoiceAmount,
    memo:       `Pontmore escrow ${escrow.escrow_id} (${authPubkey.slice(0, 8)})`,
  });

  await setFunderInvoice(escrowId, authPubkey, paymentHash, paymentRequest);

  return {
    escrow_id:        escrow.escrow_id,
    funder_pubkey:    authPubkey,
    payment_hash:    paymentHash,
    payment_request: paymentRequest,
    amount_sats:     invoiceAmount,
    funding_model:   model,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// fund_status — observe funding state (per-funder for multi-party models)
// ─────────────────────────────────────────────────────────────────────────────

async function fundStatus({ escrowId, authPubkey }) {
  const escrow = await getEscrowInstance(escrowId);
  requireParticipant(escrow, authPubkey);

  const model = escrow.funding_model;

  if (escrow.state === 'FUNDED' || escrow.state === 'SETTLED') {
    return { escrow_id: escrow.escrow_id, state: escrow.state, funded: true, funding_model: model };
  }

  // single_funder: check the single invoice on the escrow row.
  if (model === 'single_funder') {
    if (escrow.state !== 'PENDING_FUNDING' || !escrow.blink_payment_hash) {
      return { escrow_id: escrow.escrow_id, state: escrow.state, funded: false, funding_model: model };
    }

    const { status } = await getInvoiceStatus(escrow.blink_payment_hash);
    if (status === 'PAID') {
      try { await transitionState(escrow.escrow_id, 'PENDING_FUNDING', 'FUNDED'); }
      catch (err) { if (!(err instanceof StateConflictError)) throw err; }
      return { escrow_id: escrow.escrow_id, state: 'FUNDED', funded: true, invoice_status: status, funding_model: model };
    }
    if (status === 'EXPIRED') {
      try { await transitionState(escrow.escrow_id, 'PENDING_FUNDING', 'CANCELLED'); }
      catch (err) { if (!(err instanceof StateConflictError)) throw err; }
      return { escrow_id: escrow.escrow_id, state: 'CANCELLED', funded: false, invoice_status: status, funding_model: model };
    }
    return { escrow_id: escrow.escrow_id, state: escrow.state, funded: false, invoice_status: status, funding_model: model };
  }

  // two_party / n_of_m: check this funder's invoice, then aggregate.
  const funder = await getFunderRow(escrowId, authPubkey);
  if (!funder || !funder.blink_payment_hash) {
    return {
      escrow_id:     escrow.escrow_id,
      state:         escrow.state,
      funded:        false,
      funding_model: model,
      funder_status: 'no_invoice',
    };
  }

  let myFunded = funder.funded;

  if (!myFunded) {
    const { status } = await getInvoiceStatus(funder.blink_payment_hash);
    if (status === 'PAID') {
      await setFunderFunded(escrowId, authPubkey);
      myFunded = true;
    } else if (status === 'EXPIRED') {
      return {
        escrow_id:       escrow.escrow_id,
        state:           escrow.state,
        funded:          false,
        funding_model:   model,
        funder_status:   'expired',
      };
    }
  }

  // Aggregate across all funders.
  const stats = await getFunderStats(escrowId);
  const threshold = model === 'two_party'
    ? 2
    : (escrow.funding_threshold || stats.totalCount);

  const allFunded = stats.fundedCount >= threshold;

  if (allFunded && escrow.state === 'PENDING_FUNDING') {
    try { await transitionState(escrow.escrow_id, 'PENDING_FUNDING', 'FUNDED'); }
    catch (err) { if (!(err instanceof StateConflictError)) throw err; }
  }

  return {
    escrow_id:          escrow.escrow_id,
    state:              allFunded ? 'FUNDED' : escrow.state,
    funded:             allFunded,
    funding_model:      model,
    funded_count:       stats.fundedCount,
    total_funders:      stats.totalCount,
    funding_threshold:  threshold,
    my_funded:          myFunded,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// release — request release of the escrowed amount to the payee
// ─────────────────────────────────────────────────────────────────────────────

async function release({ escrowId, authPubkey, decisionBody }) {
  const escrow = await getEscrowInstance(escrowId);
  requireParticipant(escrow, authPubkey);

  if (escrow.state !== 'FUNDED' && escrow.state !== 'DISPUTED') {
    throw new ValidationError(`release requires state FUNDED or DISPUTED; escrow is ${escrow.state}`);
  }

  // Attach funder data for n_of_m release-decision verification.
  if (escrow.funding_model !== 'single_funder') {
    escrow._funders = await listFunders(escrowId);
  }

  const result = verifyDecision(escrow, 'release', decisionBody);
  if (!result.ok) throw new ValidationError(`release decision rejected: ${result.error}`);

  await setReleaseDecision(escrow.escrow_id, result.decision.type, result.decision);

  // Determine payout target based on recipient role and funding model.
  const recipientPubkey = result.recipient === 'counterparty'
    ? escrow.counterparty_pubkey
    : escrow.creator_pubkey;

  if (!recipientPubkey) throw new ValidationError('no recipient pubkey bound for this recipient role');

  const payoutSats = escrow.amount_sats;
  const payoutAddress = escrow.payout_ln_address;

  await transitionState(escrow.escrow_id, escrow.state, 'SETTLED');

  const payout = await executePayout(escrow, payoutSats, payoutAddress, recipientPubkey);
  await setPayoutSuccessful(escrow.escrow_id);

  return {
    escrow_id:   escrow.escrow_id,
    state:       'SETTLED',
    recipient:   result.recipient,
    payout_sats: payoutSats,
    payout,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// refund — request refund of the escrowed amount to the funder(s)
// ─────────────────────────────────────────────────────────────────────────────

async function refund({ escrowId, authPubkey, decisionBody }) {
  const escrow = await getEscrowInstance(escrowId);
  requireParticipant(escrow, authPubkey);

  if (escrow.state !== 'FUNDED' && escrow.state !== 'DISPUTED') {
    throw new ValidationError(`refund requires state FUNDED or DISPUTED; escrow is ${escrow.state}`);
  }

  // Attach funder data for n_of_m release-decision verification.
  if (escrow.funding_model !== 'single_funder') {
    escrow._funders = await listFunders(escrowId);
  }

  const result = verifyDecision(escrow, 'refund', decisionBody);
  if (!result.ok) throw new ValidationError(`refund decision rejected: ${result.error}`);

  await setReleaseDecision(escrow.escrow_id, result.decision.type, result.decision);

  await transitionState(escrow.escrow_id, escrow.state, 'CANCELLED');

  // single_funder: refund the full amount to the creator (funder).
  if (escrow.funding_model === 'single_funder') {
    const refundSats = escrow.amount_sats;
    const refundAddress = escrow.refund_ln_address;
    const payout = await executePayout(escrow, refundSats, refundAddress, escrow.creator_pubkey);
    return {
      escrow_id:   escrow.escrow_id,
      state:       'CANCELLED',
      recipient:   'creator',
      refund_sats: refundSats,
      payout,
    };
  }

  // two_party / n_of_m: refund each funder their contributed amount.
  const funders = await listFunders(escrowId);
  const refunds = [];
  for (const funder of funders) {
    const refundSats = funder.amount_sats;
    const refundAddress = funder.refund_ln_address;
    const payout = await executePayout(escrow, refundSats, refundAddress, funder.funder_pubkey);
    refunds.push({
      funder_pubkey: funder.funder_pubkey,
      refund_sats:   refundSats,
      payout,
    });
  }

  await setPayoutSuccessful(escrowId);

  return {
    escrow_id:    escrow.escrow_id,
    state:        'CANCELLED',
    recipient:    'creator',
    refund_sats:  funders.reduce((sum, f) => sum + f.amount_sats, 0),
    refunds,
    funding_model: escrow.funding_model,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// cancel — request cancellation of an unfunded or unresolved escrow instance
// ─────────────────────────────────────────────────────────────────────────────

async function cancel({ escrowId, authPubkey }) {
  const escrow = await getEscrowInstance(escrowId);
  requireParticipant(escrow, authPubkey);

  if (escrow.state === 'SETTLED' || escrow.state === 'CANCELLED') {
    throw new ValidationError(`escrow is already terminal (${escrow.state})`);
  }
  if (escrow.state === 'FUNDED') {
    throw new ValidationError('cannot cancel a funded escrow; use refund with a valid decision');
  }

  await transitionState(escrow.escrow_id, escrow.state, 'CANCELLED');
  return { escrow_id: escrow.escrow_id, state: 'CANCELLED' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function requireParticipant(escrow, pubkey) {
  if (!pubkey) throw new ValidationError('authenticated pubkey required');

  const model = escrow.funding_model;

  if (model === 'single_funder' || model === 'two_party') {
    const bound = [escrow.creator_pubkey, escrow.counterparty_pubkey].filter(Boolean);
    if (!bound.includes(pubkey)) {
      throw new ValidationError('authenticated pubkey is not a bound participant of this escrow instance');
    }
    return;
  }

  // n_of_m: participant is valid if they are the creator or a registered funder.
  // For n_of_m, escrow._funders may not be loaded yet in all code paths, so
  // we allow creator + counterparty as a fallback. escrow.js loads _funders
  // before release/refund verification. For funding_instructions and
  // fund_status the getFunderRow check serves as the authoritative gate.
  if (model === 'n_of_m') {
    if (escrow.creator_pubkey === pubkey) return;
    if (escrow.counterparty_pubkey === pubkey) return;
    if (Array.isArray(escrow._funders) && escrow._funders.some(f => f.funder_pubkey === pubkey)) return;
    // If funders aren't loaded, allow it — the funder-row lookup downstream
    // will reject if they're not actually registered.
    if (!Array.isArray(escrow._funders)) return;
    throw new ValidationError('authenticated pubkey is not a bound participant of this escrow instance');
  }

  const bound = [escrow.creator_pubkey, escrow.counterparty_pubkey].filter(Boolean);
  if (!bound.includes(pubkey)) {
    throw new ValidationError('authenticated pubkey is not a bound participant of this escrow instance');
  }
}

async function executePayout(escrow, sats, lnAddress, recipientPubkey) {
  if (lnAddress && lnAddress.includes('@')) {
    try {
      return await payToLightningAddress({ lnAddress, amountSats: sats });
    } catch (err) {
      if (err instanceof LnAddressPayoutError) {
        return { status: 'pending_bolt11', reason: err.message, recipient_pubkey: recipientPubkey };
      }
      throw err;
    }
  }
  return { status: 'pending_bolt11', reason: 'no payout_ln_address on file', recipient_pubkey: recipientPubkey, required_amount_sats: sats };
}

module.exports = {
  create,
  fundingInstructions,
  fundStatus,
  release,
  refund,
  cancel,
  requireParticipant,
};
