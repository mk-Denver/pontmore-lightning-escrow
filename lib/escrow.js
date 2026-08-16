'use strict';

/**
 * lib/escrow.js
 *
 * Core escrow instance operations for a PIP-01 custodial escrow service.
 * Each operation maps to one of the canonical service.operations vocabulary:
 * create, funding_instructions, fund_status, release, refund, cancel.
 *
 * PIP-01 two-party funding (m of n with n = 2):
 *   - 1_of_2: one of the two declared funders must fund (threshold 1).
 *   - 2_of_2: both declared funders must fund (threshold 2).
 * Per-participant invoices live in escrow_funders; the escrow becomes active
 * once the funding_threshold is met.
 *
 * Participant identity is the authenticated Nostr pubkey (hex) from NIP-98.
 */

const { config, calculatePlatformFee } = require('../config/env');
const { isHexPubkey } = require('./nostr-auth');
const { verifyDecision } = require('./release-decisions');

const DISPUTE_CLASSES = Object.freeze([
  'payment_not_received',
  'payment_amount_mismatch',
  'payout_not_sent',
  'payout_amount_mismatch',
  'escrow_funding_failure',
  'conflicting_external_confirmations',
  'fraud_or_impersonation_risk',
  'timeout_and_abandonment',
]);

const {
  StateConflictError,
  NotFoundError,
  ValidationError,
  createEscrowInstance,
  getEscrowInstance,
  joinEscrowInstance,
  transitionState,
  setReleaseDecision,
  setPayoutSuccessful,
  getFunderRow,
  setFunderInvoice,
  setFunderFunded,
  listFunders,
  getFunderStats,
  createEnrollment,
  listEnrollments,
  claimEnrollment,
  releaseEnrollmentClaim,
  consumeDecisionNonce,
  fileDispute: persistDispute,
} = require('../services/supabase');

const {
  createLightningInvoice,
  getInvoiceStatus,
  payToLightningAddress,
  LnAddressPayoutError,
} = require('../services/blink');

// ─────────────────────────────────────────────────────────────────────────────
// create — open a new escrow instance and bind the creator pubkey
// ─────────────────────────────────────────────────────────────────────────────

async function create({ authPubkey, amountSats, description, refundLnAddress, idempotencyKey, enrollmentToken, participantPubkeys, fundingModel, fundingThreshold, participantCount }) {
  if (!isHexPubkey(authPubkey)) throw new ValidationError('authenticated pubkey is not valid');

  if (enrollmentToken) {
    return joinByEnrollment({ authPubkey, enrollmentToken, payoutLnAddress: refundLnAddress });
  }

  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    throw new ValidationError('amount_sats must be a positive integer');
  }
  if (description && (description.length < 1 || description.length > 500)) {
    throw new ValidationError('description must be 1-500 characters');
  }

  if (!fundingModel) throw new ValidationError('funding_model is required for a new escrow instance');
  if (!config.ACCEPTED_FUNDING_MODELS.includes(fundingModel)) {
    throw new ValidationError(`funding_model "${fundingModel}" is not accepted by this service. Accepted: ${config.ACCEPTED_FUNDING_MODELS.join(', ')}`);
  }
  if (fundingThreshold !== undefined || participantCount !== undefined) {
    throw new ValidationError('funding_threshold and participant_count are fixed by funding_model (two-party escrow); omit both fields');
  }
  if (participantPubkeys !== undefined) {
    throw new ValidationError('participant_pubkeys is not accepted; share the returned enrollment token with the counterparty instead');
  }

  const resolvedThreshold = fundingModel === '1_of_2' ? 1 : 2;
  const resolvedParticipantCount = config.PARTICIPANT_COUNT;
  const expectedInvitees = resolvedParticipantCount - 1;

  const platformFeeSats = calculatePlatformFee(amountSats);

  const escrow = await createEscrowInstance({
    creatorPubkey:    authPubkey,
    amountSats,
    platformFeeSats,
    description:      description ?? '',
    fundingModel:     fundingModel,
    fundingThreshold: resolvedThreshold,
    participantCount: resolvedParticipantCount,
    refundLnAddress:  refundLnAddress ?? null,
    idempotencyKey,
  });

  let enrollments = [];
  if (escrow._idempotent) {
    const existingEnrollments = await listEnrollments(escrow.escrow_id);
    if (
      escrow.amount_sats !== amountSats
      || escrow.funding_model !== fundingModel
      || (escrow.funding_threshold ?? null) !== resolvedThreshold
      || (escrow.participant_count ?? null) !== resolvedParticipantCount
      || existingEnrollments.length !== expectedInvitees
    ) {
      throw new ValidationError(
        'idempotency_key is already associated with a different escrow request; use a new idempotency_key for a new invitation'
      );
    }

    enrollments = existingEnrollments
      .filter((item) => !item.redeemed_at)
      .map((item) => ({ enrollment_token: item.enrollment_token }));
  } else {
    for (let i = 0; i < expectedInvitees; i++) {
      const token = await createEnrollment(escrow.escrow_id);
      enrollments.push({ enrollment_token: token });
    }
  }

  return {
    escrow_id:           escrow.escrow_id,
    state:               escrow.state,
    creator_pubkey:      escrow.creator_pubkey,
    amount_sats:         escrow.amount_sats,
    platform_fee_sats:   escrow.platform_fee_sats,
    funding_model:       escrow.funding_model,
    funding_threshold:   escrow.funding_threshold ?? null,
    participant_count:   escrow.participant_count ?? null,
    enrollments,
    funding_deadline:    escrow.funding_deadline,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// join — counterparty enrolls using a service-issued invitation token
// ─────────────────────────────────────────────────────────────────────────────

async function joinByEnrollment({ authPubkey, enrollmentToken, payoutLnAddress }) {
  const claim = await claimEnrollment(enrollmentToken, authPubkey);
  const escrowId = claim.escrowId;

  let updated;
  try {
    updated = await joinEscrowInstance(escrowId, authPubkey, payoutLnAddress);
  } catch (err) {
    // Release the claim so the token can be retried. Do not let a rollback
    // failure mask the original error — log it and surface the real cause.
    try { await releaseEnrollmentClaim(claim); }
    catch (rollbackErr) { console.error('[escrow] releaseEnrollmentClaim failed during rollback:', rollbackErr.message); }
    throw err;
  }

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
  await requireParticipant(escrow, authPubkey);

  if (['released', 'refunded', 'canceled'].includes(escrow.state)) {
    const hasInstructions = Boolean((await getFunderRow(escrowId, authPubkey))?.blink_payment_request);
    if (!hasInstructions) throw new ValidationError('terminal escrow has no funding instructions for this participant');
  } else if (!['created', 'partially_funded', 'active', 'release_pending'].includes(escrow.state)) {
    throw new ValidationError(`escrow is ${escrow.state}; cannot generate funding instructions`);
  }

  const model = escrow.funding_model;

  // Two-party: per-funder invoices.
  const funder = await getFunderRow(escrowId, authPubkey);
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
  await requireParticipant(escrow, authPubkey);

  const model = escrow.funding_model;

  if (['active', 'released', 'refunded'].includes(escrow.state)) {
    return { escrow_id: escrow.escrow_id, state: escrow.state, funded: true, funding_model: model, counterparty_pubkey: escrow.counterparty_pubkey ?? null };
  }
  if (escrow.state === 'canceled') {
    return { escrow_id: escrow.escrow_id, state: escrow.state, funded: false, funding_model: model, counterparty_pubkey: escrow.counterparty_pubkey ?? null };
  }

  // Synchronize every issued invoice so one status call can advance the instance.
  const funders = await listFunders(escrowId);
  for (const row of funders) {
    if (row.funded || !row.blink_payment_hash) continue;
    const { status } = await getInvoiceStatus(row.blink_payment_hash);
    if (status === 'PAID') await setFunderFunded(escrowId, row.funder_pubkey);
  }

  const funder = await getFunderRow(escrowId, authPubkey);
  if (!funder || !funder.blink_payment_hash) {
    return {
      escrow_id:           escrow.escrow_id,
      state:               escrow.state,
      funded:              false,
      funding_model:       model,
      funder_status:       'no_invoice',
      total_funders:       funders.length,
      funded_count:        funders.filter((f) => f.funded).length,
      counterparty_pubkey: escrow.counterparty_pubkey ?? null,
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
        escrow_id:           escrow.escrow_id,
        state:               escrow.state,
        funded:              false,
        funding_model:       model,
        funder_status:       'expired',
        counterparty_pubkey: escrow.counterparty_pubkey ?? null,
      };
    }
  }

  // Aggregate across all funders; the funding threshold is 1 (1_of_2) or 2 (2_of_2).
  const stats = await getFunderStats(escrowId);
  if (!Number.isInteger(escrow.funding_threshold) || escrow.funding_threshold < 1) {
    throw new ValidationError(`escrow ${escrow.escrow_id} is missing a valid funding_threshold`);
  }
  const threshold = escrow.funding_threshold;

  const allFunded = stats.fundedCount >= threshold;

  const nextState = allFunded ? 'active' : stats.fundedCount > 0 ? 'partially_funded' : 'created';
  if (nextState !== escrow.state) {
    try { await transitionState(escrow.escrow_id, escrow.state, nextState); }
    catch (err) { if (!(err instanceof StateConflictError)) throw err; }
  }

  return {
    escrow_id:          escrow.escrow_id,
    state:              nextState,
    funded:             allFunded,
    funding_model:      model,
    funded_count:       stats.fundedCount,
    total_funders:      stats.totalCount,
    funding_threshold:  threshold,
    my_funded:          myFunded,
    counterparty_pubkey: escrow.counterparty_pubkey ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// release — request release of the escrowed amount to the payee
// ─────────────────────────────────────────────────────────────────────────────

async function release({ escrowId, authPubkey, decisionBody }) {
  const escrow = await getEscrowInstance(escrowId);
  await requireParticipant(escrow, authPubkey);

  if (!['active', 'release_pending', 'disputed'].includes(escrow.state)) {
    throw new ValidationError(`release requires state active, release_pending, or disputed; escrow is ${escrow.state}`);
  }

  // attach funder data for release-decision verification.
  escrow._funders = await listFunders(escrowId);

  const result = verifyDecision(escrow, 'release', decisionBody);
  if (!result.ok) throw new ValidationError(`release decision rejected: ${result.error}`);
  await consumeDecisionNonce(escrow.escrow_id, result.decision.nonce);

  const recipientPubkey = isHexPubkey(result.recipient)
    ? result.recipient
    : result.recipient === 'counterparty'
      ? escrow.counterparty_pubkey
      : escrow.creator_pubkey;

  if (!recipientPubkey) throw new ValidationError('no recipient pubkey bound for this recipient role');

  const payoutSats = escrow._funders.filter((funder) => funder.funded)
    .reduce((sum, funder) => sum + funder.amount_sats, 0);
  if (payoutSats <= 0) throw new ValidationError('no funded principal is available for release');

  await setReleaseDecision(escrow.escrow_id, result.decision.type, {
    ...result.decision,
    recipient: result.recipient,
    payout_sats: payoutSats,
  });

  const recipientFunder = escrow._funders.find((funder) => funder.funder_pubkey === recipientPubkey);
  const payoutAddress = recipientFunder?.payout_ln_address || recipientFunder?.refund_ln_address || escrow.payout_ln_address;

  await transitionState(escrow.escrow_id, escrow.state, 'released');

  const payout = await executePayout(escrow, payoutSats, payoutAddress, recipientPubkey, 'release');
  if (payout.status !== 'pending_bolt11') await setPayoutSuccessful(escrow.escrow_id);

  return {
    escrow_id:   escrow.escrow_id,
    state:       'released',
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
  await requireParticipant(escrow, authPubkey);

  if (!['active', 'release_pending', 'disputed'].includes(escrow.state)) {
    throw new ValidationError(`refund requires state active, release_pending, or disputed; escrow is ${escrow.state}`);
  }

  // attach funder data for release-decision verification.
  escrow._funders = await listFunders(escrowId);

  const result = verifyDecision(escrow, 'refund', decisionBody);
  if (!result.ok) throw new ValidationError(`refund decision rejected: ${result.error}`);
  await consumeDecisionNonce(escrow.escrow_id, result.decision.nonce);

  await setReleaseDecision(escrow.escrow_id, result.decision.type, result.decision);

  await transitionState(escrow.escrow_id, escrow.state, 'refunded');

  // Refund each funded funder their contributed amount.
  const funders = await listFunders(escrowId);
  const fundedFunders = funders.filter(f => f.funded);
  const refunds = [];
  for (const funder of fundedFunders) {
    const refundSats = funder.amount_sats;
    const refundAddress = funder.refund_ln_address;
    const payout = await executePayout(escrow, refundSats, refundAddress, funder.funder_pubkey, 'refund');
    refunds.push({
      funder_pubkey: funder.funder_pubkey,
      refund_sats:   refundSats,
      payout,
    });
  }

  if (refunds.every((item) => item.payout.status !== 'pending_bolt11')) await setPayoutSuccessful(escrowId);

  return {
    escrow_id:    escrow.escrow_id,
    state:        'refunded',
    recipient:    'creator',
    refund_sats:  fundedFunders.reduce((sum, f) => sum + f.amount_sats, 0),
    refunds,
    funding_model: escrow.funding_model,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// cancel — request cancellation of an unfunded or unresolved escrow instance
// ─────────────────────────────────────────────────────────────────────────────

async function cancel({ escrowId, authPubkey }) {
  const escrow = await getEscrowInstance(escrowId);
  await requireParticipant(escrow, authPubkey);

  if (['released', 'refunded', 'canceled'].includes(escrow.state)) {
    throw new ValidationError(`escrow is already terminal (${escrow.state})`);
  }
  if (['active', 'release_pending', 'disputed'].includes(escrow.state)) {
    throw new ValidationError('cannot cancel an active escrow; use refund with a valid decision');
  }
  if (new Date(escrow.funding_deadline).getTime() > Date.now() && escrow.state === 'partially_funded') {
    throw new ValidationError('partially funded escrow cannot be canceled before funding_deadline');
  }

  // Blink is the source of truth for payment status. Refresh every issued
  // invoice before deciding whether a timeout cancellation owes refunds.
  for (const funder of await listFunders(escrowId)) {
    if (funder.funded || !funder.blink_payment_hash) continue;
    const { status } = await getInvoiceStatus(funder.blink_payment_hash);
    if (status === 'PAID') await setFunderFunded(escrowId, funder.funder_pubkey);
  }
  const stats = await getFunderStats(escrowId);
  if (stats.fundedCount > 0 && escrow.state === 'created') {
    throw new ValidationError('escrow has partial funding; refresh fund_status before cancellation');
  }

  const refunds = [];
  for (const funder of (await listFunders(escrowId)).filter((row) => row.funded)) {
    const payout = await executePayout(escrow, funder.amount_sats, funder.refund_ln_address, funder.funder_pubkey, 'cancel-refund');
    refunds.push({ funder_pubkey: funder.funder_pubkey, refund_sats: funder.amount_sats, payout });
  }
  await transitionState(escrow.escrow_id, escrow.state, 'canceled');
  if (refunds.length > 0 && refunds.every((item) => item.payout.status !== 'pending_bolt11')) await setPayoutSuccessful(escrowId);
  return { escrow_id: escrow.escrow_id, state: 'canceled', refunds };
}

// ─────────────────────────────────────────────────────────────────────────────
// dispute — a bound participant raises a dispute on an active escrow instance
// ─────────────────────────────────────────────────────────────────────────────

async function fileDispute({ escrowId, authPubkey, disputeClass, summary }) {
  if (!DISPUTE_CLASSES.includes(disputeClass)) {
    throw new ValidationError(`dispute_class must be one of: ${DISPUTE_CLASSES.join(', ')}`);
  }
  if (summary && (summary.length < 1 || summary.length > 1000)) {
    throw new ValidationError('summary must be 1-1000 characters');
  }
  const escrow = await getEscrowInstance(escrowId);
  await requireParticipant(escrow, authPubkey);

  const result = await persistDispute(escrowId, {
    disputeClass,
    summary,
    openedBy: authPubkey,
  });

  return {
    escrow_id:          result.escrow_id,
    state:              result.state,
    dispute_class:      result.dispute_class,
    dispute_opened_by:  result.dispute_opened_by,
    dispute_opened_at:  result.dispute_opened_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function requireParticipant(escrow, pubkey) {
  if (!pubkey) throw new ValidationError('authenticated pubkey required');

  // Two-party: participants are the creator and the single counterparty.
  const bound = [escrow.creator_pubkey, escrow.counterparty_pubkey].filter(Boolean);
  if (!bound.includes(pubkey)) {
    throw new ValidationError('authenticated pubkey is not a bound participant of this escrow instance');
  }
}

async function executePayout(escrow, sats, lnAddress, recipientPubkey, purpose) {
  if (lnAddress && lnAddress.includes('@')) {
    try {
      return await payToLightningAddress({
        lnAddress,
        amountSats: sats,
        idempotencyKey: `escrow-payout:${escrow.escrow_id}:${purpose}:${recipientPubkey}`,
      });
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
  fileDispute,
  requireParticipant,
};
