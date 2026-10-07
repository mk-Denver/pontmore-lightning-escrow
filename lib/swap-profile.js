'use strict';

/**
 * lib/swap-profile.js
 *
 * pontmore/swap@1 — Bilateral Fiat/Bitcoin Swap Profile.
 *
 * Defines the swap-specific terms, participant roles, profile actions,
 * authorization rules, and state reconstruction for the PIP-02 kernel.
 *
 * This profile preserves "swap" as the application domain term. It defines:
 *   - Participant roles: swap/agent, swap/customer
 *   - Terms: direction, fiat, bitcoin, payment_channel, deadlines
 *   - Profile actions: swap/fiat_sent, swap/fiat_confirmed
 *   - Dispute classes: fiat_not_received, incorrect_fiat_amount, etc.
 *
 * The kernel invariants (PIP-02) are enforced by lib/pip02.js; this
 * module supplies the profile-specific rules that the kernel delegates to.
 */

const PROFILE_ID = 'pontmore/swap@1';

const SWAP_ROLES = {
  AGENT: 'swap/agent',
  CUSTOMER: 'swap/customer',
};

const SWAP_ACTIONS = new Set([
  'swap/fiat_sent',
  'swap/fiat_confirmed',
]);

const SWAP_DISPUTE_CLASSES = new Set([
  'fiat_not_received',
  'incorrect_fiat_amount',
  'payment_reference_invalid',
  'escrow_not_secured',
  'bitcoin_not_released',
  'conflicting_confirmation',
  'timeout',
]);

const VALID_DIRECTIONS = new Set(['fiat_to_btc', 'btc_to_fiat']);

/**
 * Validate swap terms per the profile spec.
 * @param {object} terms
 * @returns {string[]} errors (empty if valid)
 */
function validateTerms(terms) {
  const errors = [];

  if (typeof terms.direction !== 'string' || !VALID_DIRECTIONS.has(terms.direction)) {
    errors.push('terms.direction must be "fiat_to_btc" or "btc_to_fiat"');
  }

  // fiat
  if (!terms.fiat || typeof terms.fiat !== 'object') {
    errors.push('terms.fiat must be an object');
  } else {
    if (typeof terms.fiat.currency !== 'string' || !/^[A-Z]{3}$/.test(terms.fiat.currency)) {
      errors.push('terms.fiat.currency must be an uppercase ISO 4217 code (3 letters)');
    }
    if (typeof terms.fiat.amount !== 'string' || !/^\d+(\.\d+)?$/.test(terms.fiat.amount) || parseFloat(terms.fiat.amount) <= 0) {
      errors.push('terms.fiat.amount must be a positive base-10 decimal string');
    }
  }

  // bitcoin
  if (!terms.bitcoin || typeof terms.bitcoin !== 'object') {
    errors.push('terms.bitcoin must be an object');
  } else {
    if (typeof terms.bitcoin.amount !== 'string' || !/^\d+$/.test(terms.bitcoin.amount) || BigInt(terms.bitcoin.amount) <= 0n) {
      errors.push('terms.bitcoin.amount must be a positive base-10 integer string');
    }
    if (terms.bitcoin.unit !== 'sat') {
      errors.push('terms.bitcoin.unit must be "sat"');
    }
    if (typeof terms.bitcoin.network !== 'string' || terms.bitcoin.network.length === 0) {
      errors.push('terms.bitcoin.network must be a non-empty string');
    }
  }

  // payment_channel
  if (typeof terms.payment_channel !== 'string' || terms.payment_channel.length === 0) {
    errors.push('terms.payment_channel must be a non-empty versioned identifier string');
  }

  // deadlines
  if (!terms.deadlines || typeof terms.deadlines !== 'object') {
    errors.push('terms.deadlines must be an object');
  } else {
    if (!Number.isInteger(terms.deadlines.fiat_pay_by) || terms.deadlines.fiat_pay_by <= 0) {
      errors.push('terms.deadlines.fiat_pay_by must be a positive Unix timestamp integer');
    }
    if (!Number.isInteger(terms.deadlines.fiat_confirm_by) || terms.deadlines.fiat_confirm_by <= 0) {
      errors.push('terms.deadlines.fiat_confirm_by must be a positive Unix timestamp integer');
    }
    if (Number.isInteger(terms.deadlines.fiat_pay_by) && Number.isInteger(terms.deadlines.fiat_confirm_by)
      && terms.deadlines.fiat_pay_by >= terms.deadlines.fiat_confirm_by) {
      errors.push('terms.deadlines.fiat_pay_by must be earlier than fiat_confirm_by');
    }
  }

  return errors;
}

/**
 * Validate commitments. The swap profile permits two commitment keys:
 * private_terms and quote, both using sha256-bytes@1.
 */
function validateCommitments(commitments) {
  const errors = [];
  const allowedKeys = new Set(['private_terms', 'quote']);
  const allowedAlgorithms = new Set(['sha256-bytes@1']);

  for (const [key, commit] of Object.entries(commitments)) {
    if (!allowedKeys.has(key)) {
      errors.push(`commitment key "${key}" is not permitted by pontmore/swap@1`);
    }
    if (!commit || typeof commit.algorithm !== 'string' || !allowedAlgorithms.has(commit.algorithm)) {
      errors.push(`commitment "${key}" algorithm must be sha256-bytes@1`);
    }
    if (typeof commit.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(commit.digest)) {
      errors.push(`commitment "${key}" digest must be "sha256:" followed by 64 hex chars`);
    }
  }

  return errors;
}

/**
 * Derive the economic roles from the direction.
 */
function deriveEconomicRoles(terms) {
  const direction = terms.direction;
  if (direction === 'fiat_to_btc') {
    return {
      fiatSender: SWAP_ROLES.CUSTOMER,
      fiatReceiver: SWAP_ROLES.AGENT,
      bitcoinProvider: SWAP_ROLES.AGENT,
      bitcoinRecipient: SWAP_ROLES.CUSTOMER,
    };
  }
  // btc_to_fiat
  return {
    fiatSender: SWAP_ROLES.AGENT,
    fiatReceiver: SWAP_ROLES.CUSTOMER,
    bitcoinProvider: SWAP_ROLES.CUSTOMER,
    bitcoinRecipient: SWAP_ROLES.AGENT,
  };
}

/**
 * Resolve a role name to a pubkey from the root's role map.
 */
function resolveRole(root, role) {
  return root.roleMap[role]?.[0] ?? null;
}

/**
 * Authorize a profile action or delegate kernel actions with profile conditions.
 *
 * Called by the PIP-02 kernel for actions that are not purely kernel actions.
 */
function authorizeAction(actionType, signer, state, root) {
  const terms = root.content.terms;
  const econRoles = deriveEconomicRoles(terms);
  const proposer = root.pubkey;

  // Identify the non-proposing participant (the acceptor).
  const agent = resolveRole(root, SWAP_ROLES.AGENT);
  const customer = resolveRole(root, SWAP_ROLES.CUSTOMER);
  const allAppParticipants = [agent, customer].filter(Boolean);
  const nonProposer = allAppParticipants.find((pk) => pk !== proposer) ?? null;
  const proposerRole = agent === proposer ? SWAP_ROLES.AGENT : SWAP_ROLES.CUSTOMER;

  // Kernel actions with profile-specific conditions.
  switch (actionType) {
    case 'core/accept':
      if (signer !== nonProposer) {
        return { ok: false, error: 'core/accept must be signed by the non-proposing application participant' };
      }
      return { ok: true };

    case 'core/decline':
      if (signer !== nonProposer) {
        return { ok: false, error: 'core/decline must be signed by the non-proposing application participant' };
      }
      return { ok: true };

    case 'core/cancel':
      // Proposer: before acceptance. Either participant: after acceptance but before core/secure.
      if (state === 'proposed') {
        if (signer !== proposer) {
          return { ok: false, error: 'core/cancel before acceptance must be signed by the proposer' };
        }
        return { ok: true };
      }
      if (state === 'accepted') {
        if (!allAppParticipants.includes(signer)) {
          return { ok: false, error: 'core/cancel after acceptance must be signed by an application participant' };
        }
        return { ok: true };
      }
      return { ok: false, error: 'core/cancel is only valid before acceptance or before securing' };

    case 'core/expire':
      if (!allAppParticipants.includes(signer)) {
        return { ok: false, error: 'core/expire must be signed by an application participant' };
      }
      return { ok: true };

    case 'core/authorize_settlement': {
      // Fiat receiver authorizes settlement, after swap/fiat_confirmed.
      const fiatReceiverRole = econRoles.fiatReceiver;
      const fiatReceiverPubkey = resolveRole(root, fiatReceiverRole);
      if (signer !== fiatReceiverPubkey) {
        return { ok: false, error: `core/authorize_settlement must be signed by the fiat receiver (${fiatReceiverRole})` };
      }
      return { ok: true };
    }

    case 'core/authorize_refund': {
      // Bitcoin provider authorizes refund when fiat_pay_by elapsed with no fiat_sent.
      const bitcoinProviderRole = econRoles.bitcoinProvider;
      const bitcoinProviderPubkey = resolveRole(root, bitcoinProviderRole);
      if (signer !== bitcoinProviderPubkey) {
        return { ok: false, error: `core/authorize_refund must be signed by the Bitcoin provider (${bitcoinProviderRole})` };
      }
      return { ok: true };
    }

    case 'core/open_dispute':
      if (!allAppParticipants.includes(signer)) {
        return { ok: false, error: 'core/open_dispute must be signed by an application participant' };
      }
      // Validate dispute class if present.
      return { ok: true };

    default:
      // Profile actions.
      if (actionType === 'swap/fiat_sent') {
        const fiatSenderRole = econRoles.fiatSender;
        const fiatSenderPubkey = resolveRole(root, fiatSenderRole);
        if (signer !== fiatSenderPubkey) {
          return { ok: false, error: `swap/fiat_sent must be signed by the fiat sender (${fiatSenderRole})` };
        }
        if (!['accepted', 'secured'].includes(state)) {
          return { ok: false, error: 'swap/fiat_sent requires the accepted or secured state' };
        }
        return { ok: true };
      }

      if (actionType === 'swap/fiat_confirmed') {
        const fiatReceiverRole = econRoles.fiatReceiver;
        const fiatReceiverPubkey = resolveRole(root, fiatReceiverRole);
        if (signer !== fiatReceiverPubkey) {
          return { ok: false, error: `swap/fiat_confirmed must be signed by the fiat receiver (${fiatReceiverRole})` };
        }
        if (state !== 'fiat_sent') {
          return { ok: false, error: 'swap/fiat_confirmed requires the fiat_sent state' };
        }
        return { ok: true };
      }

      return { ok: false, error: `unknown action "${actionType}" for pontmore/swap@1` };
  }
}

/**
 * Compute the next state for profile actions.
 */
function computeNextState(state, actionType, act, root) {
  if (actionType === 'swap/fiat_sent') return 'fiat_sent';
  if (actionType === 'swap/fiat_confirmed') return 'fiat_confirmed';
  return state;
}

/**
 * Profile actions that may only be performed once.
 */
const ONCE_ONLY_ACTIONS = ['swap/fiat_sent', 'swap/fiat_confirmed'];

/**
 * Whether this profile permits disputes.
 */
const PERMITS_DISPUTES = true;

/**
 * Validate profile-action data (called by the kernel after structural validation).
 * @param {string} actionType
 * @param {object} data - action content.data
 * @returns {string[]} errors (empty if valid)
 */
function validateActionData(actionType, data) {
  const errors = [];
  if (actionType === 'swap/fiat_sent' || actionType === 'swap/fiat_confirmed') {
    if (!data || typeof data.payment_reference !== 'string' || data.payment_reference.length === 0) {
      errors.push(`${actionType}.data.payment_reference must be a non-empty string`);
    }
  }
  if (actionType === 'core/open_dispute' && data && data.class !== undefined) {
    if (typeof data.class !== 'string' || !SWAP_DISPUTE_CLASSES.has(data.class)) {
      errors.push(`core/open_dispute.data.class must be one of: ${[...SWAP_DISPUTE_CLASSES].join(', ')}`);
    }
  }
  return errors;
}

module.exports = {
  id: PROFILE_ID,
  SWAP_ROLES,
  SWAP_ACTIONS,
  SWAP_DISPUTE_CLASSES,
  VALID_DIRECTIONS,
  validateTerms,
  validateCommitments,
  deriveEconomicRoles,
  resolveRole,
  authorizeAction,
  computeNextState,
  validateActionData,
  onceOnlyActions: ONCE_ONLY_ACTIONS,
  permitsDisputes: PERMITS_DISPUTES,
};
