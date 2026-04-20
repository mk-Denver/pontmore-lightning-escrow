/**
 * config/env.js
 *
 * Centralised environment variable loader and validator.
 *
 * CHANGE LOG (v2)
 * ───────────────
 * - Removed `PLATFORM_FEE_MIN_SATS` entirely.  The fee is now a straight
 *   percentage of the trade amount with no floor.
 * - Updated `calculatePlatformFee` and introduced `splitPlatformFee` which
 *   divides the calculated fee 50/50 between buyer and seller.
 */

'use strict';

if (process.env.NODE_ENV !== 'production') {
  try { require('dotenv').config(); } catch { /* devDependency, ignore in prod */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────────────

function requireString(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`[config/env] Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function requirePositiveNumber(name) {
  const raw = requireString(name);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `[config/env] Environment variable ${name} must be a positive number. Got: "${raw}"`
    );
  }
  return value;
}

function requireUrl(name, opts = {}) {
  const raw = requireString(name);
  try { new URL(raw); } catch {
    throw new Error(
      `[config/env] Environment variable ${name} is not a valid URL. Got: "${raw}"`
    );
  }
  if (opts.noTrailingSlash && raw.endsWith('/')) {
    throw new Error(
      `[config/env] Environment variable ${name} must NOT have a trailing slash. Got: "${raw}"`
    );
  }
  return raw;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validated, frozen config object
// ─────────────────────────────────────────────────────────────────────────────

const config = Object.freeze({
  // ── Telegram ──────────────────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN:       requireString('TELEGRAM_BOT_TOKEN'),
  TELEGRAM_WEBHOOK_SECRET:  requireString('TELEGRAM_WEBHOOK_SECRET'),
  ADMIN_TELEGRAM_ID:        requireString('ADMIN_TELEGRAM_ID'),
  WEBHOOK_DOMAIN:           requireUrl('WEBHOOK_DOMAIN', { noTrailingSlash: true }),

  // ── Supabase ──────────────────────────────────────────────────────────────
  SUPABASE_PROJECT_URL:      requireUrl('SUPABASE_PROJECT_URL'),
  SUPABASE_SERVICE_ROLE_KEY: requireString('SUPABASE_SERVICE_ROLE_KEY'),

  // ── Blink API ─────────────────────────────────────────────────────────────
  BLINK_GRAPHQL_ENDPOINT: requireUrl('BLINK_GRAPHQL_ENDPOINT'),
  BLINK_API_KEY:          requireString('BLINK_API_KEY'),

  // ── Platform Fee ──────────────────────────────────────────────────────────
  /**
   * Straight decimal percentage of the trade amount — no floor.
   * e.g. 0.02 = 2%.
   * The total fee is split 50/50: buyer pays half on top of the trade amount;
   * seller receives the trade amount minus the other half.
   */
  PLATFORM_FEE_PERCENTAGE: requirePositiveNumber('PLATFORM_FEE_PERCENTAGE'),

  // ── Server ────────────────────────────────────────────────────────────────
  PORT: Number(process.env.PORT) || 3000,
});

// ─────────────────────────────────────────────────────────────────────────────
// Fee helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the TOTAL platform fee for a given trade amount.
 * Fee = amountSats x PLATFORM_FEE_PERCENTAGE, rounded up to nearest sat.
 *
 * @param {number} amountSats
 * @returns {number} Total platform fee in satoshis (integer).
 */
function calculatePlatformFee(amountSats) {
  return Math.ceil(amountSats * config.PLATFORM_FEE_PERCENTAGE);
}

/**
 * Split the total platform fee 50/50 between buyer and seller.
 *
 * On an odd-satoshi fee, the buyer absorbs the extra sat (pays `ceil`).
 *
 * Buyer pays:    amountSats + buyerFeeSats   (invoice amount)
 * Seller gets:   amountSats - sellerFeeSats  (payout amount)
 *
 * @param {number} totalFeeSats - Output of calculatePlatformFee().
 * @returns {{ buyerFeeSats: number, sellerFeeSats: number }}
 */
function splitPlatformFee(totalFeeSats) {
  const sellerFeeSats = Math.floor(totalFeeSats / 2);
  const buyerFeeSats  = totalFeeSats - sellerFeeSats; // picks up odd sat
  return { buyerFeeSats, sellerFeeSats };
}

module.exports = { config, calculatePlatformFee, splitPlatformFee };