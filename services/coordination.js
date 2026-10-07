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
 * Store a validated coordination root event.
 */
async function storeRoot(rootEvent, parsed) {
  const db = supabase();
  const { error } = await db.from('coordination_roots').upsert({
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
  }, { onConflict: 'coordination_id' });

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
 * Store a validated coordination action event.
 * Returns the updated chain tip.
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
  if (error) throw new Error(`[coordination] storeAction failed: ${error.message}`);

  // Update the chain tip (unless forked).
  const { error: updateErr } = await db.from('coordination_roots')
    .update({ chain_tip: actionEvent.id })
    .eq('coordination_id', parsed.coordinationId)
    .eq('forked', false);
  if (updateErr) throw new Error(`[coordination] chain tip update failed: ${updateErr.message}`);
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
  let current = root.chain_tip && root.forked ? null : root.coordination_id;
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
 * Update the derived state on the root row.
 */
async function updateState(coordinationId, state, terminal, forked) {
  const db = supabase();
  const updates = { state };
  if (forked !== undefined) updates.forked = forked;
  const { error } = await db.from('coordination_roots')
    .update(updates)
    .eq('coordination_id', coordinationId);
  if (error) throw new Error(`[coordination] updateState failed: ${error.message}`);
}

module.exports = {
  storeRoot,
  getRoot,
  storeAction,
  listActions,
  getOrderedChain,
  updateState,
};
