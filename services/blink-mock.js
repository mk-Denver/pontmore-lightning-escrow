'use strict';

/**
 * services/blink-mock.js
 *
 * In-memory fake Blink backend. Selected by services/blink.js when
 * BLINK_MODE=mock. It mimics the real Blink module's surface so the full
 * escrow state machine (invoice creation → funding → release/refund payout)
 * can be exercised without real Lightning sats.
 *
 * Invoices start PENDING and are flipped to PAID via markInvoicePaid(), which
 * the /test/* endpoints call. Payouts always succeed (no real funds move).
 *
 * NEVER use mock mode in production: no custody, no real payments.
 */

const real = require('./blink-real');

// Re-export the real error classes so `instanceof` checks (e.g. escrow.js
// checking `err instanceof LnAddressPayoutError`) stay consistent across modes.
const { BlinkApiError, LnAddressPayoutError } = real;

// paymentHash -> { status, paymentRequest, amountSats, memo }
const invoices = new Map();

const MOCK_WALLET_ID = 'mock-btc-wallet-id';

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function initBlink() {
  console.warn('[blink-mock] MOCK mode active — no real Lightning funds are used.');
  console.log(`[blink-mock] Initialised. BTC Wallet ID: ${MOCK_WALLET_ID}`);
}

async function getBtcWalletId() {
  return MOCK_WALLET_ID;
}

async function createLightningInvoice({ amountSats, memo }) {
  const paymentHash = randomHex(32);
  const paymentRequest = `lnbcrt${amountSats}1mock-${paymentHash}`;
  invoices.set(paymentHash, {
    status: 'PENDING',
    paymentRequest,
    amountSats,
    memo: memo ?? '',
  });
  return { paymentHash, paymentRequest };
}

async function getInvoiceStatus(paymentHash) {
  const inv = invoices.get(paymentHash);
  if (!inv) throw new BlinkApiError(`Invoice not found for hash: ${paymentHash}`);
  return { status: inv.status };
}

async function payToLightningAddress({ lnAddress, amountSats }) {
  if (!lnAddress || !lnAddress.includes('@')) {
    throw new LnAddressPayoutError(lnAddress, 'Invalid Lightning Address format.');
  }
  return { status: 'SUCCESS', transactionId: `mock-tx-${randomHex(8)}` };
}

async function payBolt11Invoice({ paymentRequest }) {
  return { status: 'SUCCESS', transactionId: `mock-tx-${randomHex(8)}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pricing (deterministic mock; not used for custody)
// ─────────────────────────────────────────────────────────────────────────────

async function getRealtimePrice(_currency) {
  return 0.001; // fiat per sat placeholder
}

async function satsToFiat(sats) {
  return Math.round(sats * 0.001);
}

async function fiatToSats(fiat) {
  return Math.round(fiat / 0.001);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test-only hooks (not present on the real backend)
// ─────────────────────────────────────────────────────────────────────────────

function markInvoicePaid(paymentHash) {
  const inv = invoices.get(paymentHash);
  if (!inv) return false;
  inv.status = 'PAID';
  return true;
}

function markInvoiceExpired(paymentHash) {
  const inv = invoices.get(paymentHash);
  if (!inv) return false;
  inv.status = 'EXPIRED';
  return true;
}

function listInvoices() {
  return Array.from(invoices.entries()).map(([hash, inv]) => ({ paymentHash: hash, ...inv }));
}

function resetMock() {
  invoices.clear();
}

module.exports = {
  BlinkApiError,
  LnAddressPayoutError,
  initBlink,
  getBtcWalletId,
  createLightningInvoice,
  getInvoiceStatus,
  payToLightningAddress,
  payBolt11Invoice,
  getRealtimePrice,
  satsToFiat,
  fiatToSats,
  // test-only
  markInvoicePaid,
  markInvoiceExpired,
  listInvoices,
  resetMock,
  isMock: true,
};
