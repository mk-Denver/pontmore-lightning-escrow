/**
 * services/blink.js
 *
 * All interactions with the Blink Lightning API (https://dev.blink.sv).
 *
 * ARCHITECTURE OVERVIEW
 * ──────────────────────
 * Blink exposes a single GraphQL endpoint.  Every call in this file is a
 * thin wrapper that:
 *   1. Builds the GraphQL query/mutation string and variables object.
 *   2. POSTs to BLINK_GRAPHQL_ENDPOINT with the API key in the header.
 *   3. Checks for `errors` arrays at both the HTTP and GraphQL layer.
 *   4. Returns the relevant data object to the caller.
 *
 * WALLET ID CACHING
 * ──────────────────
 * The Blink API requires a `walletId` (UUID) for most mutations.  We fetch
 * it once at startup via `getBtcWalletId()` and cache it in module scope.
 * Call `initBlink()` from bot.js during startup before accepting any updates.
 *
 * PAYOUT STRATEGY (per spec)
 * ───────────────────────────
 * 1. Try to pay via the recipient's stored Lightning Address (user@domain.com).
 * 2. If that fails (address unreachable, insufficient liquidity, etc.), fall
 *    back to requesting a BOLT11 invoice from the user via Telegram and paying
 *    that instead.
 * The `payToLightningAddress` function implements step 1 and throws a
 * `LnAddressPayoutError` on failure so the caller can implement step 2.
 */

'use strict';

const { config } = require('../config/env');

// node-fetch v3 is ESM-only; if you're on Node 18+ the built-in `fetch` is
// available globally.  We fall back to the global gracefully.
let fetchFn;
try {
  fetchFn = fetch; // Node 18+ built-in
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

/** Thrown when an LN Address payout fails — signals the bot to fall back to BOLT11. */
class LnAddressPayoutError extends BlinkApiError {
  constructor(lnAddress, cause) {
    super(`LN Address payout to "${lnAddress}" failed: ${cause}`);
    this.name = 'LnAddressPayoutError';
    this.lnAddress = lnAddress;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level wallet ID cache
// ─────────────────────────────────────────────────────────────────────────────

/** @type {string | null} */
let _cachedBtcWalletId = null;

// ─────────────────────────────────────────────────────────────────────────────
// Internal GraphQL transport
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a GraphQL operation against the Blink API.
 *
 * @param {string}  document  - GraphQL query or mutation string.
 * @param {object}  variables - Variables object.
 * @returns {Promise<object>}  - The `data` field from the GraphQL response.
 * @throws {BlinkApiError}    - On HTTP errors or GraphQL-level errors.
 */
async function blinkRequest(document, variables = {}) {
  let response;
  try {
    response = await fetchFn(config.BLINK_GRAPHQL_ENDPOINT, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        // Blink uses the `X-API-KEY` header for authentication.
        'X-API-KEY': config.BLINK_API_KEY,
      },
      body: JSON.stringify({ query: document, variables }),
    });
  } catch (networkError) {
    throw new BlinkApiError(`Network error calling Blink API: ${networkError.message}`);
  }

  if (!response.ok) {
    throw new BlinkApiError(
      `Blink API HTTP ${response.status}: ${response.statusText}`
    );
  }

  let json;
  try {
    json = await response.json();
  } catch {
    throw new BlinkApiError('Blink API returned non-JSON response.');
  }

  // GraphQL spec: top-level `errors` array signals partial or total failure.
  if (json.errors && json.errors.length > 0) {
    const messages = json.errors.map((e) => e.message).join('; ');
    throw new BlinkApiError(`Blink GraphQL error: ${messages}`, json.errors);
  }

  return json.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wallet helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query the Blink API for the BTC wallet ID associated with our API key.
 * Caches the result in module scope for the lifetime of the process.
 *
 * @returns {Promise<string>} - The BTC wallet UUID.
 */
async function getBtcWalletId() {
  if (_cachedBtcWalletId) return _cachedBtcWalletId;

  const data = await blinkRequest(/* GraphQL */ `
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
    throw new BlinkApiError(
      'No BTC wallet found on the Blink account associated with BLINK_API_KEY.'
    );
  }

  _cachedBtcWalletId = btcWallet.id;
  return _cachedBtcWalletId;
}

/**
 * Initialise the Blink service.  Call this once at bot startup to warm the
 * wallet ID cache and surface API key problems early.
 *
 * @returns {Promise<void>}
 */
async function initBlink() {
  const walletId = await getBtcWalletId();
  console.log(`[blink] Initialised. BTC Wallet ID: ${walletId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Invoice creation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a Lightning invoice on the Blink wallet for the given amount.
 * The buyer will pay this invoice to fund the escrow.
 *
 * @param {{
 *   amountSats:  number,  - Invoice amount in satoshis (trade amount + fee).
 *   memo:        string,  - Human-readable description shown on the invoice.
 *   expirySeconds?: number - Seconds until invoice expires (default: 3600 = 1 h).
 * }} params
 *
 * @returns {Promise<{
 *   paymentHash:    string,  - Unique identifier; stored in escrows.blink_payment_hash.
 *   paymentRequest: string,  - BOLT11 invoice string (lnbc…).
 *   expiresAt:      string,  - ISO-8601 expiry timestamp.
 * }>}
 */
async function createLightningInvoice({ amountSats, memo, expirySeconds = 3600 }) {
  const walletId = await getBtcWalletId();

  const data = await blinkRequest(/* GraphQL */ `
    mutation LnInvoiceCreate($input: LnInvoiceCreateInput!) {
      lnInvoiceCreate(input: $input) {
        invoice {
          paymentHash
          paymentRequest
          paymentSecret
          satoshis
          expiresAt
        }
        errors {
          message
          code
          path
        }
      }
    }
  `, {
    input: {
      walletId,
      amount:      amountSats,
      memo:        memo.slice(0, 100), // Blink enforces a memo length limit.
      expiresIn:   expirySeconds,
    },
  });

  const result = data?.lnInvoiceCreate;

  // Blink surfaces mutation-level errors inside the payload (not at top level).
  if (result?.errors?.length > 0) {
    const messages = result.errors.map((e) => e.message).join('; ');
    throw new BlinkApiError(`lnInvoiceCreate failed: ${messages}`, result.errors);
  }

  const invoice = result?.invoice;
  if (!invoice?.paymentRequest) {
    throw new BlinkApiError('lnInvoiceCreate returned no invoice data.');
  }

  return {
    paymentHash:    invoice.paymentHash,
    paymentRequest: invoice.paymentRequest,
    expiresAt:      invoice.expiresAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Invoice status check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check whether a previously created invoice has been paid.
 * Used by the webhook/polling handler to confirm escrow funding.
 *
 * @param {string} paymentHash - The paymentHash from createLightningInvoice.
 * @returns {Promise<{
 *   status:      'PENDING' | 'PAID' | 'EXPIRED',
 *   amountPaid?: number,
 * }>}
 */
async function getInvoiceStatus(paymentHash) {
  const walletId = await getBtcWalletId();

  const data = await blinkRequest(/* GraphQL */ `
    query InvoiceStatus($walletId: WalletId!, $paymentHash: PaymentHash!) {
      me {
        defaultAccount {
          walletById(walletId: $walletId) {
            ... on BTCWallet {
              invoiceByHash(paymentHash: $paymentHash) {
                paymentStatus
                satoshis
              }
            }
          }
        }
      }
    }
  `, { walletId, paymentHash });

  const invoice = data?.me?.defaultAccount?.walletById?.invoiceByHash;
  if (!invoice) throw new BlinkApiError(`Invoice not found for hash: ${paymentHash}`);

  return {
    status:      invoice.paymentStatus, // 'PENDING' | 'PAID' | 'EXPIRED'
    amountPaid:  invoice.satoshis ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Payouts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pay a Lightning Address directly from the Blink wallet.
 *
 * This is the PRIMARY payout path (per spec).  On failure, the caller should
 * catch `LnAddressPayoutError` and fall back to requesting a BOLT11 invoice.
 *
 * Lightning Addresses follow the format user@domain.com and are resolved by
 * Blink to a BOLT11 invoice internally.
 *
 * @param {{
 *   lnAddress:   string,  - Recipient Lightning Address (user@domain.com).
 *   amountSats:  number,  - Amount to send in satoshis (after fee deduction).
 *   memo:        string,  - Payment memo / description.
 * }} params
 *
 * @returns {Promise<{
 *   status:        string,  - 'SUCCESS' | 'PENDING' | 'FAILURE'
 *   transactionId: string,
 * }>}
 * @throws {LnAddressPayoutError} If the payout fails for any reason.
 */
async function payToLightningAddress({ lnAddress, amountSats, memo }) {
  const walletId = await getBtcWalletId();

  // Basic LN address format validation before hitting the API.
  if (!lnAddress || !lnAddress.includes('@')) {
    throw new LnAddressPayoutError(lnAddress, 'Invalid Lightning Address format.');
  }

  let data;
  try {
    data = await blinkRequest(/* GraphQL */ `
      mutation LnAddressPaymentSend($input: LnAddressPaymentSendInput!) {
        lnAddressPaymentSend(input: $input) {
          status
          transaction {
            id
          }
          errors {
            message
            code
            path
          }
        }
      }
    `, {
      input: {
        walletId,
        lnAddress,
        amount: amountSats,
        memo:   memo.slice(0, 100),
      },
    });
  } catch (err) {
    // Wrap any BlinkApiError in an LnAddressPayoutError so the caller sees
    // exactly what type of failure this is and knows to try BOLT11 fallback.
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
    status:        result.status,
    transactionId: result.transaction?.id ?? 'unknown',
  };
}

/**
 * Pay a BOLT11 invoice from the Blink wallet.
 *
 * This is the FALLBACK payout path used when an LN Address payment fails.
 * The bot will have asked the recipient to supply this invoice via Telegram.
 *
 * @param {{
 *   paymentRequest: string,  - BOLT11 invoice (lnbc…).
 *   memo:           string,
 * }} params
 *
 * @returns {Promise<{
 *   status:        string,
 *   transactionId: string,
 * }>}
 * @throws {BlinkApiError}
 */
async function payBolt11Invoice({ paymentRequest, memo }) {
  const walletId = await getBtcWalletId();

  const data = await blinkRequest(/* GraphQL */ `
    mutation LnInvoicePaymentSend($input: LnInvoicePaymentSendInput!) {
      lnInvoicePaymentSend(input: $input) {
        status
        transaction {
          id
        }
        errors {
          message
          code
          path
        }
      }
    }
  `, {
    input: {
      walletId,
      paymentRequest,
      memo: memo.slice(0, 100),
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
    status:        result.status,
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
};