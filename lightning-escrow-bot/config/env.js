/**
 * config/env.js
 *
 * Centralised environment variable loader and validator.
 *
 * HOW IT WORKS
 * ─────────────
 * This module is imported ONCE at the very top of bot.js (the process entry
 * point) before any other module is loaded.  It reads every required variable
 * from `process.env`, validates presence and basic type constraints, then
 * freezes the resulting config object so nothing in the runtime can mutate it.
 *
 * FAIL-FAST PRINCIPLE
 * ────────────────────
 * If any required variable is missing or obviously malformed the module throws
 * a descriptive Error immediately.  This surfaces misconfiguration at deploy
 * time (Railway will log the crash) rather than silently at runtime when the
 * first real transaction arrives.
 */

'use strict';

// Load .env in non-production environments (dev / local).
// In Railway the variables are injected directly into process.env, so dotenv
// will simply find nothing to load and exit silently — that's fine.
if (process.env.NODE_ENV !== 'production') {
  try {
    require('dotenv').config();
  } catch {
    // dotenv is a devDependency; if somehow missing in prod, ignore.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read a required string variable.  Throws if absent or blank.
 * @param {string} name - The name of the environment variable.
 * @returns {string}
 */
function requireString(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`[config/env] Missing required environment variable: ${name}`);
  }
  return value.trim();
}

/**
 * Read a required positive number variable.  Throws if absent or not a
 * finite positive number.
 * @param {string} name
 * @returns {number}
 */
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

/**
 * Read a required URL variable.  Performs a basic URL parse to catch obvious
 * typos (missing scheme, trailing slash on WEBHOOK_DOMAIN, etc.).
 * @param {string} name
 * @param {{ noTrailingSlash?: boolean }} [opts]
 * @returns {string}
 */
function requireUrl(name, opts = {}) {
  const raw = requireString(name);
  try {
    new URL(raw); // throws on invalid URL
  } catch {
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
// Validation & Export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validated, frozen configuration object.
 * Import this anywhere in the codebase instead of accessing process.env
 * directly.
 *
 * @type {Readonly<{
 *   TELEGRAM_BOT_TOKEN: string,
 *   TELEGRAM_WEBHOOK_SECRET: string,
 *   ADMIN_TELEGRAM_ID: string,
 *   WEBHOOK_DOMAIN: string,
 *   SUPABASE_PROJECT_URL: string,
 *   SUPABASE_SERVICE_ROLE_KEY: string,
 *   BLINK_GRAPHQL_ENDPOINT: string,
 *   BLINK_API_KEY: string,
 *   PLATFORM_FEE_PERCENTAGE: number,
 *   PLATFORM_FEE_MIN_SATS: number,
 *   PORT: number,
 * }>}
 */
const config = Object.freeze({
  // ── Telegram ──────────────────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN: requireString('TELEGRAM_BOT_TOKEN'),

  /**
   * A secret token Telegram will include in every webhook POST as the header
   * `X-Telegram-Bot-Api-Secret-Token`.  Our Express middleware verifies this
   * to reject spoofed requests.
   */
  TELEGRAM_WEBHOOK_SECRET: requireString('TELEGRAM_WEBHOOK_SECRET'),

  /**
   * The Telegram numeric user-ID (as a *string*) of the human admin who
   * receives dispute dossiers and presses the Refund / Payout buttons.
   */
  ADMIN_TELEGRAM_ID: requireString('ADMIN_TELEGRAM_ID'),

  /**
   * Public HTTPS base URL of this server (no trailing slash).
   * Railway exposes the service at a generated .up.railway.app domain.
   * Telegram will POST updates to: WEBHOOK_DOMAIN/telegram/<secret_path>
   */
  WEBHOOK_DOMAIN: requireUrl('WEBHOOK_DOMAIN', { noTrailingSlash: true }),

  // ── Supabase ──────────────────────────────────────────────────────────────
  SUPABASE_PROJECT_URL: requireUrl('SUPABASE_PROJECT_URL'),
  SUPABASE_SERVICE_ROLE_KEY: requireString('SUPABASE_SERVICE_ROLE_KEY'),

  // ── Blink API ─────────────────────────────────────────────────────────────
  BLINK_GRAPHQL_ENDPOINT: requireUrl('BLINK_GRAPHQL_ENDPOINT'),
  BLINK_API_KEY: requireString('BLINK_API_KEY'),

  // ── Platform Fee ──────────────────────────────────────────────────────────
  /**
   * Decimal percentage, e.g. 0.02 = 2 %.
   * Fee = MAX(amountSats * PLATFORM_FEE_PERCENTAGE, PLATFORM_FEE_MIN_SATS)
   */
  PLATFORM_FEE_PERCENTAGE: requirePositiveNumber('PLATFORM_FEE_PERCENTAGE'),

  /**
   * Absolute floor for the platform fee in satoshis.
   */
  PLATFORM_FEE_MIN_SATS: requirePositiveNumber('PLATFORM_FEE_MIN_SATS'),

  // ── Server ────────────────────────────────────────────────────────────────
  /** HTTP port.  Railway injects PORT automatically. */
  PORT: Number(process.env.PORT) || 3000,
});

// ─────────────────────────────────────────────────────────────────────────────
// Fee calculation helper — lives here because it depends on config constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the platform fee for a given trade amount.
 *
 * Rule: fee = MAX(amountSats × PLATFORM_FEE_PERCENTAGE, PLATFORM_FEE_MIN_SATS)
 * Result is always rounded UP to the nearest satoshi.
 *
 * @param {number} amountSats - The escrow trade amount in satoshis.
 * @returns {number} Platform fee in satoshis (integer).
 */
function calculatePlatformFee(amountSats) {
  const percentageFee = amountSats * config.PLATFORM_FEE_PERCENTAGE;
  return Math.ceil(Math.max(percentageFee, config.PLATFORM_FEE_MIN_SATS));
}

module.exports = { config, calculatePlatformFee };