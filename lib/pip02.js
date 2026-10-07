'use strict';

/**
 * lib/pip02.js
 *
 * PIP-02: Coordination Event Chains.
 *
 * Implements the PIP-02 kernel: immutable coordination roots (kind 7300)
 * and append-only linked actions (kind 7301), with chain validation,
 * state derivation, kernel invariants, and fork detection.
 *
 * A pinned coordination profile (e.g. pontmore/swap@1) supplies the
 * domain-specific terms, roles, actions, and authorization rules. The
 * kernel enforces the shared invariants; the profile enforces the rest.
 */

const { verifyEvent, findTag, findTags } = require('./nostr-event');

const KIND_ROOT = 7300;
const KIND_ACTION = 7301;

const PIP02_VERSION = 2;

// Kernel action identifiers (reserved core/ namespace).
const KERNEL_ACTIONS = new Set([
  'core/accept',
  'core/decline',
  'core/secure',
  'core/authorize_settlement',
  'core/settle',
  'core/authorize_refund',
  'core/refund',
  'core/cancel',
  'core/expire',
  'core/open_dispute',
  'core/resolve_dispute',
]);

// Authority roles reserved by PIP-02.
const ROLE_ESCROW = 'core/escrow';
const ROLE_RESOLVER = 'core/resolver';

// Terminal states.
const TERMINAL_STATES = new Set([
  'declined',
  'cancelled',
  'expired',
  'settled',
  'refunded',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Root validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a kind 7300 coordination root event.
 *
 * @param {object} event - Nostr kind 7300 event
 * @param {object} profile - the pinned coordination profile module
 * @returns {{ valid: boolean, errors: string[], root: object|null }}
 */
function validateRoot(event, profile) {
  const errors = [];

  if (!event || typeof event !== 'object') {
    return { valid: false, errors: ['event is not an object'], root: null };
  }

  if (event.kind !== KIND_ROOT) {
    errors.push(`event kind must be ${KIND_ROOT}, got ${event.kind}`);
  }

  if (!verifyEvent(event)) {
    errors.push('root event signature/id verification failed');
  }

  // Required tags: one p tag per participant/authority
  const pTags = findTags(event, 'p');
  if (pTags.length < 2) {
    errors.push('root must contain at least one p tag per participant and authority');
  }

  // Build the role map: role -> [pubkeys]
  const roleMap = {};
  for (const tag of pTags) {
    const [, pubkey, , role] = tag;
    if (!pubkey || !/^[0-9a-f]{64}$/.test(pubkey)) {
      errors.push(`p tag has invalid pubkey: ${pubkey}`);
      continue;
    }
    if (!role) {
      errors.push(`p tag for ${pubkey} has no role`);
      continue;
    }
    if (!roleMap[role]) roleMap[role] = [];
    roleMap[role].push(pubkey);
  }

  // core/escrow: exactly one
  if (!roleMap[ROLE_ESCROW] || roleMap[ROLE_ESCROW].length !== 1) {
    errors.push('root must bind exactly one core/escrow pubkey');
  }

  // core/resolver: exactly one when disputes are permitted (profile decides)
  if (profile.permitsDisputes && (!roleMap[ROLE_RESOLVER] || roleMap[ROLE_RESOLVER].length !== 1)) {
    errors.push('root must bind exactly one core/resolver pubkey when the profile permits disputes');
  }

  // Escrow references: one e tag (exact event) and one a tag (addressable)
  const eEscrowTags = (event.tags || []).filter((t) => t[0] === 'e' && t[3] === 'escrow-version');
  if (eEscrowTags.length !== 1) {
    errors.push('root must contain exactly one e tag with marker "escrow-version"');
  }
  const aEscrowTags = (event.tags || []).filter((t) => t[0] === 'a' && t[3] === 'escrow');
  if (aEscrowTags.length !== 1) {
    errors.push('root must contain exactly one a tag with marker "escrow"');
  }

  // Parse content
  let content;
  try {
    content = JSON.parse(event.content);
  } catch {
    errors.push('root content is not valid JSON');
    return { valid: false, errors, root: null };
  }

  if (typeof content !== 'object' || content === null) {
    errors.push('root content must be a JSON object');
    return { valid: false, errors, root: null };
  }

  if (content.version !== PIP02_VERSION) {
    errors.push(`root content.version must be ${PIP02_VERSION}, got ${content.version}`);
  }

  if (typeof content.profile !== 'string' || content.profile.length === 0) {
    errors.push('root content.profile must be a non-empty string');
  } else if (profile.id && content.profile !== profile.id) {
    errors.push(`root content.profile "${content.profile}" does not match the loaded profile "${profile.id}"`);
  }

  if (typeof content.expires_at !== 'number' || !Number.isInteger(content.expires_at) || content.expires_at <= 0) {
    errors.push('root content.expires_at must be a positive Unix timestamp integer');
  }

  if (typeof content.terms !== 'object' || content.terms === null) {
    errors.push('root content.terms must be an object');
  } else if (profile.validateTerms) {
    const termsErrors = profile.validateTerms(content.terms);
    for (const e of termsErrors) errors.push(`terms: ${e}`);
  }

  // commitments (optional, profile-defined keys)
  if (content.commitments !== undefined) {
    if (typeof content.commitments !== 'object' || content.commitments === null) {
      errors.push('root content.commitments must be an object');
    } else {
      for (const [key, commit] of Object.entries(content.commitments)) {
        if (!commit || typeof commit.algorithm !== 'string' || typeof commit.digest !== 'string') {
          errors.push(`commitment "${key}" must contain algorithm and digest`);
        }
      }
      if (profile.validateCommitments) {
        const commitErrors = profile.validateCommitments(content.commitments);
        for (const e of commitErrors) errors.push(`commitments: ${e}`);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, root: null };
  }

  return {
    valid: true,
    errors: [],
    root: {
      eventId: event.id,
      pubkey: event.pubkey,
      createdAt: event.created_at,
      roleMap,
      content,
      raw: event,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Action validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a kind 7301 coordination action event structurally.
 *
 * @param {object} event - Nostr kind 7301 event
 * @param {object} root - parsed root (from validateRoot)
 * @param {string} expectedPrevId - the expected predecessor event id
 * @returns {{ valid: boolean, errors: string[], action: object|null }}
 */
function validateAction(event, root, expectedPrevId) {
  const errors = [];

  if (!event || typeof event !== 'object') {
    return { valid: false, errors: ['event is not an object'], action: null };
  }

  if (event.kind !== KIND_ACTION) {
    errors.push(`event kind must be ${KIND_ACTION}, got ${event.kind}`);
  }

  if (!verifyEvent(event)) {
    errors.push('action event signature/id verification failed');
  }

  // Root reference: exactly one e tag with marker "root"
  const rootRefs = (event.tags || []).filter((t) => t[0] === 'e' && t[3] === 'root');
  if (rootRefs.length !== 1) {
    errors.push('action must contain exactly one e tag with marker "root"');
  } else if (rootRefs[0][1] !== root.eventId) {
    errors.push('action root reference does not match the coordination root id');
  }

  // Predecessor reference: exactly one e tag with marker "prev"
  const prevRefs = (event.tags || []).filter((t) => t[0] === 'e' && t[3] === 'prev');
  if (prevRefs.length !== 1) {
    errors.push('action must contain exactly one e tag with marker "prev"');
  } else if (prevRefs[0][1] !== expectedPrevId) {
    errors.push('action prev reference does not match the current chain tip');
  }

  // Parse content
  let content;
  try {
    content = JSON.parse(event.content);
  } catch {
    errors.push('action content is not valid JSON');
    return { valid: false, errors, action: null };
  }

  if (typeof content !== 'object' || content === null) {
    errors.push('action content must be a JSON object');
    return { valid: false, errors, action: null };
  }

  if (content.version !== PIP02_VERSION) {
    errors.push(`action content.version must be ${PIP02_VERSION}, got ${content.version}`);
  }

  if (typeof content.action !== 'string' || content.action.length === 0) {
    errors.push('action content.action must be a non-empty string');
  }

  // data (optional)
  if (content.data !== undefined && (typeof content.data !== 'object' || content.data === null)) {
    errors.push('action content.data must be an object');
  }

  // evidence references (if present)
  if (content.data && Array.isArray(content.data.evidence)) {
    for (const ev of content.data.evidence) {
      if (!ev || typeof ev.type !== 'string' || typeof ev.value !== 'string') {
        errors.push('each evidence entry must contain type and value');
      } else if (!['event', 'commitment', 'opaque'].includes(ev.type)) {
        errors.push(`evidence type "${ev.type}" is not valid (must be event, commitment, or opaque)`);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, action: null };
  }

  return {
    valid: true,
    errors: [],
    action: {
      eventId: event.id,
      pubkey: event.pubkey,
      createdAt: event.created_at,
      actionType: content.action,
      data: content.data || {},
      content,
      raw: event,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// State derivation (chain replay)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive the coordination state by replaying a validated root and its
 * actions. Enforces kernel invariants and delegates profile-specific
 * authorization to the profile.
 *
 * @param {object} root - parsed root (from validateRoot)
 * @param {array} actions - array of parsed action objects (from validateAction), in chain order
 * @param {object} profile - the pinned coordination profile module
 * @returns {{ state: string, terminal: boolean, forked: boolean, errors: string[], history: array }}
 */
function deriveState(root, actions, profile) {
  const errors = [];
  const history = [];
  let state = 'proposed';
  let forked = false;

  // Track which semantic actions have been used (replay protection).
  const seenActions = new Set();

  // The root signer is the proposer.
  const proposer = root.pubkey;

  // Build the participant set from the root's p tags.
  const allParticipants = [];
  for (const [role, pubkeys] of Object.entries(root.roleMap)) {
    for (const pk of pubkeys) {
      if (!allParticipants.includes(pk)) allParticipants.push(pk);
    }
  }

  const escrowPubkey = root.roleMap[ROLE_ESCROW]?.[0] ?? null;
  const resolverPubkey = root.roleMap[ROLE_RESOLVER]?.[0] ?? null;

  // Track whether we've seen sibling forks at any predecessor.
  const predecessorSeen = new Set();

  for (let i = 0; i < actions.length; i++) {
    const act = actions[i];
    const actionType = act.actionType;
    const signer = act.pubkey;

    // Fork detection: if two actions claim the same predecessor, the chain forks.
    // (The caller should pass actions in chain order; a fork is detected when
    //  the same predecessor appears more than once in the action list.)
    // The caller is responsible for building the linear chain; this function
    // validates that linear chain. Fork detection at insertion time is done
    // by the storage layer.

    // No action after a terminal outcome.
    if (TERMINAL_STATES.has(state)) {
      errors.push(`action "${actionType}" attempted after terminal state "${state}"`);
      break;
    }

    // Replay detection: kernel actions that are once-only.
    const onceOnly = new Set([
      'core/accept', 'core/decline', 'core/secure',
      'core/authorize_settlement', 'core/settle',
      'core/authorize_refund', 'core/refund',
      'core/cancel', 'core/expire',
    ]);
    if (onceOnly.has(actionType) && seenActions.has(actionType)) {
      errors.push(`action "${actionType}" is a replay (already performed)`);
      break;
    }

    // Profile actions that are once-only (profile declares them).
    if (profile.onceOnlyActions) {
      for (const pa of profile.onceOnlyActions) {
        if (actionType === pa && seenActions.has(actionType)) {
          errors.push(`action "${actionType}" is a replay (already performed)`);
          break;
        }
      }
      if (errors.length > 0) break;
    }

    // Kernel authorization.
    const authResult = authorizeAction(actionType, signer, state, root, profile);
    if (!authResult.ok) {
      errors.push(`action "${actionType}" by ${signer.slice(0, 8)}… is not authorized: ${authResult.error}`);
      break;
    }

    // Kernel invariant enforcement.
    const invariantResult = checkKernelInvariants(actionType, signer, state, root, act);
    if (!invariantResult.ok) {
      errors.push(`kernel invariant violated: ${invariantResult.error}`);
      break;
    }

    // Dispute freeze: no ordinary progress while disputed.
    if (state === 'disputed') {
      if (actionType !== 'core/resolve_dispute') {
        errors.push(`action "${actionType}" is not permitted while disputed (only core/resolve_dispute)`);
        break;
      }
    }

    // Profile action data validation (for both kernel and profile actions).
    if (profile.validateActionData && act.data) {
      const dataErrors = profile.validateActionData(actionType, act.data);
      if (dataErrors.length > 0) {
        errors.push(...dataErrors);
        break;
      }
    }

    seenActions.add(actionType);
    const prevState = state;

    // Compute next state.
    state = computeNextState(state, actionType, act, root, profile);

    history.push({
      action: actionType,
      signer,
      eventId: act.eventId,
      from: prevState,
      to: state,
      data: act.data,
    });
  }

  const terminal = TERMINAL_STATES.has(state);

  return { state, terminal, forked, errors, history };
}

// ─────────────────────────────────────────────────────────────────────────────
// Authorization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine whether a signer is authorized to perform an action in the
 * current state. Kernel actions are checked here; profile actions are
 * delegated to the profile.
 */
function authorizeAction(actionType, signer, state, root, profile) {
  // Kernel actions.
  if (actionType === 'core/secure') {
    if (signer !== root.roleMap[ROLE_ESCROW]?.[0]) {
      return { ok: false, error: 'core/secure must be signed by the bound core/escrow authority' };
    }
    return { ok: true };
  }

  if (actionType === 'core/settle') {
    if (signer !== root.roleMap[ROLE_ESCROW]?.[0]) {
      return { ok: false, error: 'core/settle must be signed by the bound core/escrow authority' };
    }
    return { ok: true };
  }

  if (actionType === 'core/refund') {
    if (signer !== root.roleMap[ROLE_ESCROW]?.[0]) {
      return { ok: false, error: 'core/refund must be signed by the bound core/escrow authority' };
    }
    return { ok: true };
  }

  if (actionType === 'core/resolve_dispute') {
    if (signer !== root.roleMap[ROLE_RESOLVER]?.[0]) {
      return { ok: false, error: 'core/resolve_dispute must be signed by the bound core/resolver authority' };
    }
    return { ok: true };
  }

  // Delegate to the profile for all other actions.
  if (profile.authorizeAction) {
    return profile.authorizeAction(actionType, signer, state, root);
  }

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Kernel invariants
// ─────────────────────────────────────────────────────────────────────────────

function checkKernelInvariants(actionType, signer, state, root, act) {
  // core/authorize_settlement requires core/secure first.
  if (actionType === 'core/authorize_settlement') {
    if (state !== 'secured' && state !== 'fiat_sent' && state !== 'fiat_confirmed' && state !== 'settlement_authorized') {
      return { ok: false, error: 'core/authorize_settlement requires the swap to be secured first' };
    }
  }

  // core/settle requires settlement authorization.
  if (actionType === 'core/settle') {
    if (state !== 'settlement_authorized' && state !== 'disputed') {
      return { ok: false, error: 'core/settle requires settlement to be authorized first' };
    }
  }

  // core/refund requires refund authorization.
  if (actionType === 'core/refund') {
    if (state !== 'refund_authorized' && state !== 'disputed') {
      return { ok: false, error: 'core/refund requires refund to be authorized first' };
    }
  }

  // core/settle and core/refund are mutually exclusive (enforced by terminal state check).

  // core/resolve_dispute requires the disputed state.
  if (actionType === 'core/resolve_dispute') {
    if (state !== 'disputed') {
      return { ok: false, error: 'core/resolve_dispute requires the disputed state' };
    }
    const effect = act.data?.effect;
    if (!['resume', 'authorize_settlement', 'authorize_refund', 'cancel'].includes(effect)) {
      return { ok: false, error: 'core/resolve_dispute.data.effect must be resume, authorize_settlement, authorize_refund, or cancel' };
    }
    if (act.data && act.data.policy === undefined) {
      return { ok: false, error: 'core/resolve_dispute.data must contain policy' };
    }
  }

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// State machine
// ─────────────────────────────────────────────────────────────────────────────

function computeNextState(state, actionType, act, root, profile) {
  switch (actionType) {
    case 'core/accept':
      return 'accepted';
    case 'core/decline':
      return 'declined';
    case 'core/cancel':
      return 'cancelled';
    case 'core/expire':
      return 'expired';
    case 'core/secure':
      return 'secured';
    case 'core/authorize_settlement':
      return 'settlement_authorized';
    case 'core/settle':
      return 'settled';
    case 'core/authorize_refund':
      return 'refund_authorized';
    case 'core/refund':
      return 'refunded';
    case 'core/open_dispute':
      return 'disputed';
    case 'core/resolve_dispute': {
      const effect = act.data?.effect;
      if (effect === 'resume') {
        // Return to the pre-dispute state. For simplicity, return to the
        // last non-disputed state from the history. The caller should
        // track the pre-dispute state; here we return to 'secured' as a
        // safe default since disputes typically occur after securing.
        return act.data?._preDisputeState ?? 'secured';
      }
      if (effect === 'authorize_settlement') return 'settlement_authorized';
      if (effect === 'authorize_refund') return 'refund_authorized';
      if (effect === 'cancel') return 'cancelled';
      return state;
    }
    default:
      // Profile actions: delegate.
      if (profile.computeNextState) {
        return profile.computeNextState(state, actionType, act, root);
      }
      return state;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Full chain validation (convenience)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a full coordination chain: root + ordered actions.
 *
 * @param {object} rootEvent - Nostr kind 7300 event
 * @param {array} actionEvents - array of Nostr kind 7301 events in chain order
 * @param {object} profile - the pinned coordination profile module
 * @returns {{ valid: boolean, errors: string[], state: string, terminal: boolean, history: array }}
 */
function validateChain(rootEvent, actionEvents, profile) {
  const rootResult = validateRoot(rootEvent, profile);
  if (!rootResult.valid) {
    return { valid: false, errors: rootResult.errors, state: 'invalid', terminal: false, history: [] };
  }

  const root = rootResult.root;
  const actions = [];
  let prevId = root.eventId;
  const errors = [];

  for (const event of actionEvents) {
    const actResult = validateAction(event, root, prevId);
    if (!actResult.valid) {
      errors.push(...actResult.errors);
      break;
    }
    actions.push(actResult.action);
    prevId = actResult.action.eventId;
  }

  if (errors.length > 0) {
    return { valid: false, errors, state: 'invalid', terminal: false, history: [] };
  }

  const { state, terminal, forked, history } = deriveState(root, actions, profile);

  return {
    valid: errors.length === 0 && history.length === actions.length,
    errors,
    state,
    terminal,
    forked,
    history,
  };
}

module.exports = {
  KIND_ROOT,
  KIND_ACTION,
  PIP02_VERSION,
  KERNEL_ACTIONS,
  ROLE_ESCROW,
  ROLE_RESOLVER,
  TERMINAL_STATES,
  validateRoot,
  validateAction,
  deriveState,
  authorizeAction,
  checkKernelInvariants,
  computeNextState,
  validateChain,
};
