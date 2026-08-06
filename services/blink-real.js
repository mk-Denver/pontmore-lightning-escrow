'use strict';

/**
 * services/blink-real.js
 *
 * Lightning custody backend via the Blink GraphQL API.
 * The escrow operator holds custody of the BTC wallet; participants fund by
 * paying a hold invoice and receive payouts to Lightning Addresses or BOLT11.
 *
 * This is the only supported Lightning backend.
 */

const { config } = require('../config/env');

let fetchFn;
try { fetchFn = fetch; } catch { fetchFn = require('node-fetch'); }

// ─────────────────────────────────────────────────────────────────────────────
// Custom error types
// ─────────────────────────────────────────────────────────────────────────────

class BlinkApiError extends Error {
  constructor(message, graphqlErrors = []) {
    super(message);
    this.name = 'BlinkApiError';
    this.graphqlErrors = graphqlErrors;
  }
}

class LnAddressPayoutError extends BlinkApiError {
  constructor(lnAddress, cause) {
    super(`LN Address payout to "${lnAddress}" failed: ${cause}`);
    this.name = 'LnAddressPayoutError';
    this.lnAddress = lnAddress;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level cache
// ─────────────────────────────────────────────────────────────────────────────

let _cachedBtcWalletId = null;
let _cachedFiatPerSat = null;
let _lastPriceFetchTime = 0;
const CACHE_TTL_MS = 30 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Internal GraphQL transport
// ─────────────────────────────────────────────────────────────────────────────

async function blinkRequest(document, variables = {}) {
  if (!config.BLINK_API_KEY) {
    throw new BlinkApiError('BLINK_API_KEY is not configured');
  }
  let response;
  try {
    response = await fetchFn(config.BLINK_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': config.BLINK_API_KEY,
      },
      body: JSON.stringify({ query: document, variables }),
    });
  } catch (networkError) {
    throw new BlinkApiError(`Network error calling Blink API: ${networkError.message}`);
  }

  if (!response.ok) {
    throw new BlinkApiError(`Blink API HTTP ${response.status}: ${response.statusText}`);
  }

  let json;
  try { json = await response.json(); }
  catch { throw new BlinkApiError('Blink API returned non-JSON response.'); }

  if (json.errors && json.errors.length > 0) {
    const messages = json.errors.map((e) => e.message).join('; ');
    throw new BlinkApiError(`Blink GraphQL error: ${messages}`, json.errors);
  }
  return json.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wallet helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getBtcWalletId() {
  if (_cachedBtcWalletId) return _cachedBtcWalletId;

  const data = await blinkRequest(`
    query Me {
      me {
        defaultAccount {
          wallets { id walletCurrency }
        }
      }
    }
  `);

  const wallets = data?.me?.defaultAccount?.wallets ?? [];
  const btcWallet = wallets.find((w) => w.walletCurrency === 'BTC');
  if (!btcWallet) throw new BlinkApiError('No BTC wallet found on the Blink account.');

  _cachedBtcWalletId = btcWallet.id;
  return _cachedBtcWalletId;
}

async function initBlink() {
  const walletId = await getBtcWalletId();
  console.log(`[blink] Initialised. BTC Wallet ID: ${walletId}`);
  try {
    await getRealtimePrice(config.FIAT_CURRENCY);
    console.log(`[blink] Price cache warmed.`);
  } catch (err) {
    console.warn(`[blink] Failed to pre-warm price cache: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Real-time pricing
// ─────────────────────────────────────────────────────────────────────────────

async function getRealtimePrice(currency = config.FIAT_CURRENCY) {
  const now = Date.now();
  if (_cachedFiatPerSat && (now - _lastPriceFetchTime < CACHE_TTL_MS)) return _cachedFiatPerSat;

  const data = await blinkRequest(`
    query Conversion($amount: Float!, $currency: DisplayCurrency!) {
      currencyConversionEstimation(amount: $amount, currency: $currency) {
        btcSatAmount
      }
    }
  `, { amount: 1000, currency });

  const satsFor1000 = data?.currencyConversionEstimation?.btcSatAmount;
  if (!satsFor1000) throw new BlinkApiError('Failed to fetch conversion estimation from Blink.');

  const fiatPerSat = 1000 / satsFor1000;
  _cachedFiatPerSat = fiatPerSat;
  _lastPriceFetchTime = now;
  return fiatPerSat;
}

async function satsToFiat(sats) {
  const fiatPerSat = await getRealtimePrice(config.FIAT_CURRENCY);
  return Math.round(sats * fiatPerSat);
}

async function fiatToSats(fiat) {
  const fiatPerSat = await getRealtimePrice(config.FIAT_CURRENCY);
  return Math.round(fiat / fiatPerSat);
}

// ─────────────────────────────────────────────────────────────────────────────
// Invoice creation
// ─────────────────────────────────────────────────────────────────────────────

async function createLightningInvoice({ amountSats, memo }) {
  const walletId = await getBtcWalletId();

  const data = await blinkRequest(`
    mutation LnInvoiceCreate($input: LnInvoiceCreateInput!) {
      lnInvoiceCreate(input: $input) {
        invoice { paymentHash paymentRequest }
        errors { message }
      }
    }
  `, {
    input: {
      walletId,
      amount: amountSats,
      memo: memo ? memo.slice(0, 100) : undefined,
    },
  });

  const result = data?.lnInvoiceCreate;
  if (result?.errors?.length > 0) {
    const messages = result.errors.map((e) => e.message).join('; ');
    throw new BlinkApiError(`lnInvoiceCreate failed: ${messages}`, result.errors);
  }
  return {
    paymentHash: result.invoice.paymentHash,
    paymentRequest: result.invoice.paymentRequest,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Invoice status
// ─────────────────────────────────────────────────────────────────────────────

async function getInvoiceStatus(paymentHash) {
  const walletId = await getBtcWalletId();

  const data = await blinkRequest(`
    query InvoiceStatus($walletId: WalletId!, $paymentHash: PaymentHash!) {
      me {
        defaultAccount {
          walletById(walletId: $walletId) {
            ... on BTCWallet {
              invoiceByPaymentHash(paymentHash: $paymentHash) {
                paymentStatus
              }
            }
          }
        }
      }
    }
  `, { walletId, paymentHash });

  const invoice = data?.me?.defaultAccount?.walletById?.invoiceByPaymentHash;
  if (!invoice) throw new BlinkApiError(`Invoice not found for hash: ${paymentHash}`);
  return { status: invoice.paymentStatus };
}

// ─────────────────────────────────────────────────────────────────────────────
// Payouts
// ─────────────────────────────────────────────────────────────────────────────

async function payToLightningAddress({ lnAddress, amountSats, idempotencyKey }) {
  const walletId = await getBtcWalletId();

  if (!lnAddress || !lnAddress.includes('@')) {
    throw new LnAddressPayoutError(lnAddress, 'Invalid Lightning Address format.');
  }

  let data;
  try {
    const input = { walletId, lnAddress, amount: amountSats };
    if (idempotencyKey) input.idempotencyKey = idempotencyKey;
    data = await blinkRequest(`
      mutation LnAddressPaymentSend($input: LnAddressPaymentSendInput!) {
        lnAddressPaymentSend(input: $input) {
          status
          transaction { id }
          errors { message }
        }
      }
    `, { input });
  } catch (err) {
    throw new LnAddressPayoutError(lnAddress, err.message);
  }

  const result = data?.lnAddressPaymentSend;
  if (result?.errors?.length > 0) {
    const messages = result.errors.map((e) => e.message).join('; ');
    throw new LnAddressPayoutError(lnAddress, messages);
  }
  if (!result || result.status === 'FAILURE') {
    throw new LnAddressPayoutError(lnAddress, 'Payment returned FAILURE status.');
  }
  return { status: result.status, transactionId: result.transaction?.id ?? 'unknown' };
}

async function payBolt11Invoice({ paymentRequest }) {
  const walletId = await getBtcWalletId();

  const data = await blinkRequest(`
    mutation LnInvoicePaymentSend($input: LnInvoicePaymentInput!) {
      lnInvoicePaymentSend(input: $input) {
        status
        transaction { id }
        errors { message }
      }
    }
  `, { input: { walletId, paymentRequest } });

  const result = data?.lnInvoicePaymentSend;
  if (result?.errors?.length > 0) {
    const messages = result.errors.map((e) => e.message).join('; ');
    throw new BlinkApiError(`lnInvoicePaymentSend failed: ${messages}`, result.errors);
  }
  if (!result || result.status === 'FAILURE') {
    throw new BlinkApiError('BOLT11 payment returned FAILURE status.');
  }
  return { status: result.status, transactionId: result.transaction?.id ?? 'unknown' };
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
};
