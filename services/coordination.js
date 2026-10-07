'use strict';

/**
 * services/coordination.js
 *
 * Storage and retrieval for PIP-02 coordination event chains.
 * Persists validated coordination roots (kind 7300) and actions
 * (kind 7301) to Supabase, and reconstructs the chain for replay.
 */

const { supabase } = require('./supabase');

/**
 * Store a validated coordination root event. Insert-only: if a root with
 * the same coordination_id already exists, the call is a no-op — state,
 * chain_tip, and forked are never overwritten.
 */
async function storeRoot(rootEvent, parsed) {
  const db = supabase();

  // Check if the root already exists (insert-only semantics).
  const { data: existing } = await db.from('coordination_roots')
    .select('coordination_id')
    .eq('coordination_id', rootEvent.id)
    .maybeSingle();
  if (existing) return; // no-op: never overwrite live coordination state

  const { error } = await db.from('coordination_roots').insert({
    coordination_id: rootEvent.id,
    event_pubkey: rootEvent.pubkey,
    created_at: new Date(rootEvent.created_at * 1000).toISOString(),
    profile: parsed.content.profile,
    content: parsed.content,
    raw_event: rootEvent,
    escrow_descriptor_id: parsed.escrowDescriptorId,
    escrow_descriptor_addr: parsed.escrowDescriptorAddr,
    state: 'proposed',
    chain_tip: rootEvent.id,
    forked: false,
  });

  if (error?.code === '23505') return; // race: another insert won, treat as no-op
  if (error) throw new Error(`[coordination] storeRoot failed: ${error.message}`);
}

/**
 * Get a coordination root by its event id.
 */
async function getRoot(coordinationId) {
  const db = supabase();
  const { data, error } = await db.from('coordination_roots')
    .select('*')
    .eq('coordination_id', coordinationId)
    .maybeSingle();
  if (error) throw new Error(`[coordination] getRoot failed: ${error.message}`);
  return data;
}

/**
 * Store a validated coordination action event and atomically advance the
 * chain tip. The tip update is a compare-and-set: only advances if the
 * current tip matches the action's predecessor (prevId). If another action
 * already advanced the tip (concurrent submission), the update matches 0
 * rows — the caller treats this as a fork/concurrency error.
 */
async function storeAction(actionEvent, parsed) {
  const db = supabase();
  const { error } = await db.from('coordination_actions').insert({
    action_id: actionEvent.id,
    coordination_id: parsed.coordinationId,
    event_pubkey: actionEvent.pubkey,
    created_at: new Date(actionEvent.created_at * 1000).toISOString(),
    action_type: parsed.actionType,
    prev_id: parsed.prevId,
    content: parsed.content,
    data: parsed.data || null,
    raw_event: actionEvent,
  });
  if (error?.code === '23505') {
    throw new Error(`[coordination] duplicate action_id or (coordination_id, prev_id) — possible fork or replay`);
  }
  if (error) throw new Error(`[coordination] storeAction failed: ${error.message}`);

  // Compare-and-set the chain tip: only advance if the current tip is the
  // predecessor AND the root is not forked.
  const { data: tipUpdate, error: updateErr } = await db.from('coordination_roots')
    .update({ chain_tip: actionEvent.id })
    .eq('coordination_id', parsed.coordinationId)
    .eq('chain_tip', parsed.prevId)
    .eq('forked', false)
    .select('coordination_id')
    .maybeSingle();
  if (updateErr) throw new Error(`[coordination] chain tip update failed: ${updateErr.message}`);
  if (!tipUpdate) {
    // The tip didn't match — either a concurrent action won, or the root
    // is forked. The action is stored (it's evidence of the fork) but the
    // tip was not advanced.
    throw new Error(`[coordination] chain tip was not at ${parsed.prevId}; concurrent action or fork detected`);
  }
}

/**
 * List all actions for a coordination in chain order (root → tip).
 */
async function listActions(coordinationId) {
  const db = supabase();
  const { data, error } = await db.from('coordination_actions')
    .select('*')
    .eq('coordination_id', coordinationId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`[coordination] listActions failed: ${error.message}`);
  return data ?? [];
}

/**
 * Reconstruct the ordered action chain by following prev links from the root.
 */
async function getOrderedChain(coordinationId) {
  const root = await getRoot(coordinationId);
  if (!root) return null;

  const allActions = await listActions(coordinationId);
  const byPrev = new Map();
  for (const a of allActions) {
    if (!byPrev.has(a.prev_id)) byPrev.set(a.prev_id, []);
    byPrev.get(a.prev_id).push(a);
  }

  const ordered = [];
  // Walk forward from root: root id is the first "prev" for the first action.
  let prev = root.coordination_id;
  while (true) {
    const next = byPrev.get(prev);
    if (!next || next.length === 0) break;
    if (next.length > 1) {
      // Fork detected — stop.
      break;
    }
    ordered.push(next[0]);
    prev = next[0].action_id;
  }

  return { root, actions: ordered };
}

/**
 * Update the derived state on the root row. Never overwrites a forked or
 * terminal root — the update is guarded by `forked = false` and excludes
 * already-terminal states.
 */
async function updateState(coordinationId, state) {
  const db = supabase();
  const { error } = await db.from('coordination_roots')
    .update({ state })
    .eq('coordination_id', coordinationId)
    .eq('forked', false);
  if (error) throw new Error(`[coordination] updateState failed: ${error.message}`);
}

module.exports = {
  storeRoot,
  getRoot,
  storeAction,
  getOrderedChain,
  updateState,
};
