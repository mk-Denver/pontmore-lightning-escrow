'use strict';

if (process.env.NODE_ENV !== 'production') {
  try { require('dotenv').config(); } catch { /* devDependency, ignore in prod */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────────────

function requireString(name) {
  const value = process.env[name];
  if (value === undefined || value === null || value.trim() === '') {
    throw new Error(`[config/env] Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optionalString(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === null || value.trim() === '') return fallback;
  return value.trim();
}

function requirePositiveNumber(name) {
  const raw = requireString(name);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`[config/env] Environment variable ${name} must be a positive number. Got: "${raw}"`);
  }
  return value;
}

function requireUrl(name, opts = {}) {
  const raw = requireString(name);
  try { new URL(raw); } catch {
    throw new Error(`[config/env] Environment variable ${name} is not a valid URL. Got: "${raw}"`);
  }
  if (opts.noTrailingSlash && raw.endsWith('/')) {
    throw new Error(`[config/env] Environment variable ${name} must NOT have a trailing slash. Got: "${raw}"`);
  }
  return raw;
}

function optionalUrl(name, fallback) {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  try { new URL(raw); } catch {
    throw new Error(`[config/env] Environment variable ${name} is not a valid URL. Got: "${raw}"`);
  }
  return raw.trim();
}

// Supabase and Blink values may be blank at config time; validate presence only
// when the service is actually started.
function optionalStringOrBlank(name) {
  const value = process.env[name];
  if (value === undefined || value === null) return '';
  return value.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Pubkey normalization (accepts npub or hex)
// ─────────────────────────────────────────────────────────────────────────────

function normalizePubkey(value) {
  if (!value) return '';
  // Already hex (64 hex chars)
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  // npub (bech32 Nostr public key)
  if (value.startsWith('npub1')) {
    try {
      const { bech32 } = require('@scure/base');
      return bech32.decodeToBytes(value).bytes.reduce((h, b) => h + b.toString(16).padStart(2, '0'), '');
    } catch {
      throw new Error(`[config/env] Failed to decode npub: "${value}"`);
    }
  }
  throw new Error(`[config/env] Invalid pubkey "${value}": must be 64-char hex or npub1...`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Validated config
// ─────────────────────────────────────────────────────────────────────────────

const PORT                  = Number(process.env.PORT) || 3000;
const SERVICE_BASE_URL      = optionalUrl('SERVICE_BASE_URL', `http://localhost:${PORT}`);
const SERVICE_PATH_PREFIX   = optionalString('SERVICE_PATH_PREFIX', '/pontmore/v1');
const SERVICE_INTERFACE     = optionalString('SERVICE_INTERFACE', 'pontmore_escrow_http_v1');
const FIAT_CURRENCY         = optionalString('FIAT_CURRENCY', 'KES');
const NIP98_MAX_AGE_SECONDS = Number(process.env.NIP98_MAX_AGE_SECONDS) || 60;
const FUNDING_TIMEOUT_SECONDS = Number(process.env.FUNDING_TIMEOUT_SECONDS) || 86400;
const DECISION_MAX_AGE_SECONDS = Number(process.env.DECISION_MAX_AGE_SECONDS) || 300;

if (!Number.isInteger(FUNDING_TIMEOUT_SECONDS) || FUNDING_TIMEOUT_SECONDS < 1) {
  throw new Error('[config/env] FUNDING_TIMEOUT_SECONDS must be a positive integer');
}
if (!Number.isInteger(DECISION_MAX_AGE_SECONDS) || DECISION_MAX_AGE_SECONDS < 1) {
  throw new Error('[config/env] DECISION_MAX_AGE_SECONDS must be a positive integer');
}

// Every escrow is two-party: exactly two declared funding participants (creator + counterparty).
const PARTICIPANT_COUNT = 2;

const VALID_FUNDING_MODELS = new Set(['1_of_2', '2_of_2']);
const VALID_RELEASE_DECISIONS = new Set([
  'mutual_consent', 'operator_decision', 'oracle_signature',
  'application_signed_result', 'threshold_participant_signatures',
]);

// Comma-separated list of funding models this deployment accepts on create.
// PIP-01 limits this escrow to two-party funding: 1_of_2 (one of two declared
// funders must fund) and 2_of_2 (both declared funders must fund).
const ACCEPTED_FUNDING_MODELS = (process.env.ACCEPTED_FUNDING_MODELS || '1_of_2,2_of_2')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

for (const fm of ACCEPTED_FUNDING_MODELS) {
  if (!VALID_FUNDING_MODELS.has(fm)) {
    throw new Error(`[config/env] ACCEPTED_FUNDING_MODELS contains invalid value "${fm}". Valid: ${[...VALID_FUNDING_MODELS].join(', ')}`);
  }
}

const ACCEPTED_RELEASE_DECISIONS = (process.env.ACCEPTED_RELEASE_DECISIONS || 'mutual_consent,operator_decision,application_signed_result')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

for (const rd of ACCEPTED_RELEASE_DECISIONS) {
  if (!VALID_RELEASE_DECISIONS.has(rd)) {
    throw new Error(`[config/env] ACCEPTED_RELEASE_DECISIONS contains invalid value "${rd}". Valid: ${[...VALID_RELEASE_DECISIONS].join(', ')}`);
  }
}

const APPLICATION_SIGNER_PUBKEYS = (process.env.APPLICATION_SIGNER_PUBKEYS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(normalizePubkey);

const ORACLE_PUBKEYS = (process.env.ORACLE_PUBKEYS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(normalizePubkey);

if (ACCEPTED_RELEASE_DECISIONS.includes('oracle_signature') && ORACLE_PUBKEYS.length === 0) {
  throw new Error('[config/env] ORACLE_PUBKEYS is required when oracle_signature is advertised');
}

const OPERATOR_PUBKEY = normalizePubkey(optionalStringOrBlank('OPERATOR_PUBKEY'));
const OPERATOR_NSEC   = optionalStringOrBlank('OPERATOR_NSEC'); // nsec or hex privkey, used for signing descriptor events

// Canonical endpoint for the first advertised transport (https).
const SERVICE_ENDPOINT = SERVICE_BASE_URL.replace(/\/$/, '') + SERVICE_PATH_PREFIX;

// Versioned schema URL is stable for published standalone descriptors.
const SCHEMA_URL = SERVICE_ENDPOINT + '/openapi/v1.0.0.json';

const config = Object.freeze({
  PORT,
  SERVICE_BASE_URL,
  SERVICE_PATH_PREFIX,
  SERVICE_ENDPOINT,
  SERVICE_INTERFACE,
  SCHEMA_URL,
  PARTICIPANT_COUNT,
  ACCEPTED_FUNDING_MODELS,
  ACCEPTED_RELEASE_DECISIONS,
  APPLICATION_SIGNER_PUBKEYS,
  ORACLE_PUBKEYS,
  OPERATOR_PUBKEY,
  OPERATOR_NSEC,
  NIP98_MAX_AGE_SECONDS,
  FUNDING_TIMEOUT_SECONDS,
  DECISION_MAX_AGE_SECONDS,
  FIAT_CURRENCY,

  // Backend (may be blank until deployment)
  SUPABASE_PROJECT_URL:      optionalStringOrBlank('SUPABASE_PROJECT_URL'),
  SUPABASE_SERVICE_ROLE_KEY: optionalStringOrBlank('SUPABASE_SERVICE_ROLE_KEY'),
  BLINK_GRAPHQL_ENDPOINT:    optionalUrl('BLINK_GRAPHQL_ENDPOINT', 'https://graphql.blink.sv/graphql'),
  BLINK_API_KEY:             optionalStringOrBlank('BLINK_API_KEY'),

  // Platform fee (may be blank for descriptor-only loading)
  PLATFORM_FEE_PERCENTAGE:   Number(process.env.PLATFORM_FEE_PERCENTAGE) || 0,
});

// ─────────────────────────────────────────────────────────────────────────────
// Fee helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Total platform fee for a given escrow amount, in sats.
 * Fee = ceil(amountSats * PLATFORM_FEE_PERCENTAGE).
 */
function calculatePlatformFee(amountSats) {
  return Math.ceil(amountSats * config.PLATFORM_FEE_PERCENTAGE);
}

/**
 * Allocate the full platform fee to the funder. The recipient pays nothing.
 * funder pays:  amountSats + buyerFeeSats  (invoice amount)
 * recipient gets: amountSats               (payout amount)
 */
function splitPlatformFee(totalFeeSats) {
  return { funderFeeSats: totalFeeSats, recipientFeeSats: 0 };
}

/**
 * Whether the backend custody/database dependencies are configured.
 * The service refuses to start operation routes when false.
 *
 */
function hasBackend() {
  const hasDb = Boolean(config.SUPABASE_PROJECT_URL && config.SUPABASE_SERVICE_ROLE_KEY);
  return Boolean(hasDb && config.BLINK_API_KEY);
}

module.exports = { config, calculatePlatformFee, splitPlatformFee, hasBackend };
