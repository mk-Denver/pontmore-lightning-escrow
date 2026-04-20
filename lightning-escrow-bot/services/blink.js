/**
 * services/blink.js
 *
 * All interactions with the Blink Lightning API (https://dev.blink.sv).
 * Now includes real-time fiat price fetching using currencyConversionEstimation.
 */

'use strict';

const { config } = require('../config/env');

let fetchFn;
try {
  fetchFn = fetch; 
} catch {
  fetchFn = require('node-fetch');
}

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
// Module-level Cache
// ─────────────────────────────────────────────────────────────────────────────

let _cachedBtcWalletId = null;

// The Price Cache: Holds the price of 1 Satoshi in the target fiat currency.
let _cachedFiatPerSat = null;
let _lastPriceFetchTime = 0;
const CACHE_TTL_MS = 30 * 1000; // 30 seconds

// ─────────────────────────────────────────────────────────────────────────────
// Internal GraphQL transport
// ─────────────────────────────────────────────────────────────────────────────

async function blinkRequest(document, variables = {}) {
  let response;
  try {
    response = await fetchFn(config.BLINK_GRAPHQL_ENDPOINT, {
      method:  'POST',
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
  try {
    json = await response.json();
  } catch {
    throw new BlinkApiError('Blink API returned non-JSON response.');
  }

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
          wallets {
            id
            walletCurrency
          }
        }
      }
    }
  `);

  const wallets = data?.me?.defaultAccount?.wallets ?? [];
  const btcWallet = wallets.find((w) => w.walletCurrency === 'BTC');

  if (!btcWallet) {
    throw new BlinkApiError('No BTC wallet found on the Blink account.');
  }

  _cachedBtcWalletId = btcWallet.id;
  return _cachedBtcWalletId;
}

async function initBlink() {
  const walletId = await getBtcWalletId();
  console.log(`[blink] Initialised. BTC Wallet ID: ${walletId}`);
  try {
    await getRealtimePrice('KES');
    console.log(`[blink] Price cache warmed.`);
  } catch (err) {
    console.warn(`[blink] Failed to pre-warm price cache: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Real-time Pricing Engine
// ─────────────────────────────────────────────────────────────────────────────

async function getRealtimePrice(currency = 'KES') {
  const now = Date.now();
  
  if (_cachedFiatPerSat && (now - _lastPriceFetchTime < CACHE_TTL_MS)) {
    return _cachedFiatPerSat;
  }

  // We bypass confusing base/offset math and ask Blink explicitly: 
  // "How many Sats is 1000 KES worth?"
  const data = await blinkRequest(`
    query Conversion($amount: Float!, $currency: DisplayCurrency!) {
      currencyConversionEstimation(amount: $amount, currency: $currency) {
        btcSatAmount
      }
    }
  `, { amount: 1000, currency });

  const satsFor1000 = data?.currencyConversionEstimation?.btcSatAmount;
  if (!satsFor1000) {
    throw new BlinkApiError('Failed to fetch conversion estimation from Blink.');
  }

  // fiatPerSat = KES per 1 Satoshi
  const fiatPerSat = 1000 / satsFor1000;
  
  _cachedFiatPerSat = fiatPerSat;
  _lastPriceFetchTime = now;

  return fiatPerSat;
}

async function satsToKes(sats) {
  const fiatPerSat = await getRealtimePrice('KES');
  return Math.round(sats * fiatPerSat);
}

async function kesToSats(kes) {
  const fiatPerSat = await getRealtimePrice('KES');
  return Math.round(kes / fiatPerSat);
}
// ─────────────────────────────────────────────────────────────────────────────
// Invoice creation
// ─────────────────────────────────────────────────────────────────────────────

async function createLightningInvoice({ amountSats, memo }) {
  const walletId = await getBtcWalletId();

  // We removed expiresIn from the input, and expiresAt from the response.
  // Blink manages expiration times internally.
  const data = await blinkRequest(`
    mutation LnInvoiceCreate($input: LnInvoiceCreateInput!) {
      lnInvoiceCreate(input: $input) {
        invoice {
          paymentHash
          paymentRequest
        }
        errors {
          message
        }
      }
    }
  `, {
    input: {
      walletId,
      amount: amountSats,
      memo: memo.slice(0, 100),
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
// Invoice status check
// ─────────────────────────────────────────────────────────────────────────────

async function getInvoiceStatus(paymentHash) {
  const walletId = await getBtcWalletId();

  // Updated to use the correct 'invoiceByPaymentHash' field 
  // and removed the unnecessary 'satoshis' field.
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

  return {
    status: invoice.paymentStatus,
  };
}
// ─────────────────────────────────────────────────────────────────────────────
// Payouts
// ─────────────────────────────────────────────────────────────────────────────

async function payToLightningAddress({ lnAddress, amountSats, memo }) {
  const walletId = await getBtcWalletId();

  if (!lnAddress || !lnAddress.includes('@')) {
    throw new LnAddressPayoutError(lnAddress, 'Invalid Lightning Address format.');
  }

  let data;
  try {
    data = await blinkRequest(`
      mutation LnAddressPaymentSend($input: LnAddressPaymentSendInput!) {
        lnAddressPaymentSend(input: $input) {
          status
          transaction {
            id
          }
          errors {
            message
          }
        }
      }
    `, {
      input: {
        walletId,
        lnAddress,
        amount: amountSats,
        memo: memo.slice(0, 100),
      },
    });
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

  return {
    status: result.status,
    transactionId: result.transaction?.id ?? 'unknown',
  };
}

async function payBolt11Invoice({ paymentRequest, memo }) {
  const walletId = await getBtcWalletId();

  // We changed the input type to LnInvoicePaymentInput 
  // and removed the memo from the variables to satisfy the Blink schema.
  const data = await blinkRequest(`
    mutation LnInvoicePaymentSend($input: LnInvoicePaymentInput!) {
      lnInvoicePaymentSend(input: $input) {
        status
        transaction {
          id
        }
        errors {
          message
        }
      }
    }
  `, {
    input: {
      walletId,
      paymentRequest,
    },
  });

  const result = data?.lnInvoicePaymentSend;

  if (result?.errors?.length > 0) {
    const messages = result.errors.map((e) => e.message).join('; ');
    throw new BlinkApiError(`lnInvoicePaymentSend failed: ${messages}`, result.errors);
  }

  if (!result || result.status === 'FAILURE') {
    throw new BlinkApiError('BOLT11 payment returned FAILURE status.');
  }

  return {
    status: result.status,
    transactionId: result.transaction?.id ?? 'unknown',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

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
  satsToKes,
  kesToSats,
};