'use strict';

/**
 * lib/escrow.js
 *
 * Core escrow instance operations for a PIP-01 custodial escrow service.
 * Each operation maps to one of the canonical service.operations vocabulary:
 * create, funding_instructions, fund_status, release, refund, cancel.
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

  const escrow = await createEscrowInstance({
    creatorPubkey:    authPubkey,
    amountSats,
    platformFeeSats,
    description:      description ?? '',
    fundingModel:     config.FUNDING_MODEL,
    refundLnAddress:  refundLnAddress ?? null,
    idempotencyKey,
  });

  return {
    escrow_id:         escrow.escrow_id,
    state:             escrow.state,
    creator_pubkey:    escrow.creator_pubkey,
    amount_sats:       escrow.amount_sats,
    platform_fee_sats: escrow.platform_fee_sats,
    funding_model:     escrow.funding_model,
    invitation_token:  escrow.invitation_token,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// join — counterparty enrolls using a service-issued invitation token
// ─────────────────────────────────────────────────────────────────────────────

async function joinByInvitation({ authPubkey, invitationToken, payoutLnAddress }) {
  // The invitation token encodes the escrow_id prefix; the DB lookup matches it.
  // We resolve the instance by invitation_token, which is unique per instance.
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
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// funding_instructions — create (or return) the Lightning invoice to fund
// ─────────────────────────────────────────────────────────────────────────────

async function fundingInstructions({ escrowId, authPubkey }) {
  const escrow = await getEscrowInstance(escrowId);
  requireParticipant(escrow, authPubkey);

  if (!['PENDING_FUNDING', 'PENDING_FUNDING'].includes(escrow.state)) {
    // Allow in PENDING_FUNDING only. If already funded, report status instead.
    if (escrow.state === 'FUNDED' || escrow.state === 'SETTLED') {
      throw new ValidationError(`escrow is already ${escrow.state}; no funding instructions available`);
    }
    throw new ValidationError(`escrow is ${escrow.state}; cannot generate funding instructions`);
  }

  if (escrow.blink_payment_request) {
    return {
      escrow_id:      escrow.escrow_id,
      payment_hash:  escrow.blink_payment_hash,
      payment_request: escrow.blink_payment_request,
      amount_sats:   escrow.amount_sats + escrow.platform_fee_sats,
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
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// fund_status — observe the funding state of a participant's side
// ─────────────────────────────────────────────────────────────────────────────

async function fundStatus({ escrowId, authPubkey }) {
  const escrow = await getEscrowInstance(escrowId);
  requireParticipant(escrow, authPubkey);

  if (escrow.state === 'FUNDED' || escrow.state === 'SETTLED') {
    return { escrow_id: escrow.escrow_id, state: escrow.state, funded: true };
  }
  if (escrow.state !== 'PENDING_FUNDING' || !escrow.blink_payment_hash) {
    return { escrow_id: escrow.escrow_id, state: escrow.state, funded: false };
  }

  const { status } = await getInvoiceStatus(escrow.blink_payment_hash);
  const paid = status === 'PAID';

  if (paid) {
    try {
      await transitionState(escrow.escrow_id, 'PENDING_FUNDING', 'FUNDED');
    } catch (err) {
      if (!(err instanceof StateConflictError)) throw err;
    }
    return { escrow_id: escrow.escrow_id, state: 'FUNDED', funded: true, invoice_status: status };
  }
  if (status === 'EXPIRED') {
    try {
      await transitionState(escrow.escrow_id, 'PENDING_FUNDING', 'CANCELLED');
    } catch (err) {
      if (!(err instanceof StateConflictError)) throw err;
    }
    return { escrow_id: escrow.escrow_id, state: 'CANCELLED', funded: false, invoice_status: status };
  }
  return { escrow_id: escrow.escrow_id, state: escrow.state, funded: false, invoice_status: status };
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

  const result = verifyDecision(escrow, 'release', decisionBody);
  if (!result.ok) throw new ValidationError(`release decision rejected: ${result.error}`);

  await setReleaseDecision(escrow.escrow_id, result.decision.type, result.decision);

  // Determine payout target. In single_funder, release pays the counterparty.
  const recipientPubkey = result.recipient === 'counterparty'
    ? escrow.counterparty_pubkey
    : escrow.creator_pubkey;

  if (!recipientPubkey) throw new ValidationError('no recipient pubkey bound for this recipient role');

  const payoutSats = escrow.amount_sats; // recipient pays no fee; funder paid fee on top
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
// refund — request refund of the escrowed amount to the funder
// ─────────────────────────────────────────────────────────────────────────────

async function refund({ escrowId, authPubkey, decisionBody }) {
  const escrow = await getEscrowInstance(escrowId);
  requireParticipant(escrow, authPubkey);

  if (escrow.state !== 'FUNDED' && escrow.state !== 'DISPUTED') {
    throw new ValidationError(`refund requires state FUNDED or DISPUTED; escrow is ${escrow.state}`);
  }

  const result = verifyDecision(escrow, 'refund', decisionBody);
  if (!result.ok) throw new ValidationError(`refund decision rejected: ${result.error}`);

  await setReleaseDecision(escrow.escrow_id, result.decision.type, result.decision);

  // Refund returns to the funder (creator in single_funder).
  const refundSats = escrow.amount_sats;
  const refundAddress = escrow.refund_ln_address;

  await transitionState(escrow.escrow_id, escrow.state, 'CANCELLED');

  const payout = await executePayout(escrow, refundSats, refundAddress, escrow.creator_pubkey);

  return {
    escrow_id:   escrow.escrow_id,
    state:       'CANCELLED',
    recipient:   'creator',
    refund_sats: refundSats,
    payout,
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
  // No Lightning Address on file; request a BOLT11 invoice out-of-band.
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
