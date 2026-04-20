/**
 * bot.js
 *
 * Entry point for the Telegram Lightning Escrow Bot.
 *
 * CHANGE LOG (v2)
 * ───────────────
 * 1. FEE SPLIT  — Total platform fee is now split 50/50.  Buyer pays
 *    amountSats + buyerFeeSats (invoice amount).  Seller receives
 *    amountSats - sellerFeeSats (payout amount).  All UI messages reflect
 *    exactly what each party pays and receives.
 *
 * 2. UPFRONT SELLER LN ADDRESS  — On `invite:accept`, if the accepting user
 *    is the Seller and has no saved Lightning Address, the escrow state
 *    transition is PAUSED.  The seller is prompted for their address first.
 *    Once provided, the full acceptance flow (invoice generation, state
 *    transition, buyer notification) fires automatically.
 *
 * 3. STRICT INVOICE ROUTING  — The QR code image and lnbc… invoice string
 *    are sent ONLY to the Buyer.  The Seller receives a plain confirmation
 *    message.  No invoice data leaks to the wrong party.
 *
 * 4. STARTUP PAYOUT RECOVERY  — `recoverPendingPayouts()` runs at startup
 *    and queries for SETTLED escrows with payout_successful = false.  For
 *    each one it re-attempts the LN Address payout.  On failure it messages
 *    the Seller to claim their trapped funds via a new address.
 */

'use strict';

// ─── Fail-fast env validation (must load first) ──────────────────────────────
const { config, calculatePlatformFee, splitPlatformFee } = require('./config/env');

// ─── Core dependencies ───────────────────────────────────────────────────────
const express            = require('express');
const { Telegraf, Markup } = require('telegraf');
const QRCode             = require('qrcode');

// ─── Services ────────────────────────────────────────────────────────────────
const {
  upsertUser,
  getUserByTelegramId,
  setDefaultLnAddress,
  createEscrow,
  getEscrowById,
  setEscrowInvitee,
  transitionEscrowState,
  setPayoutSuccessful,
  getSettledUnpaidEscrows,
  incrementCompletedTrades,
  incrementDisputedTrades,
  StateConflictError,
  NotFoundError,
} = require('./services/supabase');

const {
  initBlink,
  createLightningInvoice,
  getInvoiceStatus,
  payToLightningAddress,
  payBolt11Invoice,
  LnAddressPayoutError,
  satsToKes,
  kesToSats,
} = require('./services/blink');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Secret segment of the webhook path — derived from the bot token. */
const WEBHOOK_PATH = `/telegram/${config.TELEGRAM_BOT_TOKEN.replace(':', '_')}`;

/** Prefix used in Telegram deep-link start payloads. */
const DEEP_LINK_PREFIX = 'escrow_';

// ─────────────────────────────────────────────────────────────────────────────
// Markdown sanitiser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Escape characters that Telegram Markdown v1 treats as formatting tokens.
 * Apply to every piece of user-supplied text before embedding in a message.
 *
 * @param {string|null|undefined} text
 * @returns {string}
 */
function escapeMd(text) {
  if (!text) return '';
  return String(text).replace(/([_*`\[])/g, '\\$1');
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory conversation state store
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map<userId(string), { step: string, data: object }>
 *
 * Steps used in this file:
 *   AWAITING_LN_ADDRESS            — setting a default Lightning Address
 *   ESCROW_AWAITING_ROLE           — new-escrow wizard step 1
 *   ESCROW_AWAITING_AMOUNT         — new-escrow wizard step 2
 *   ESCROW_AWAITING_DESCRIPTION    — new-escrow wizard step 3
 *   AWAITING_UPFRONT_LN_ADDRESS    — seller must provide address before accept
 *   AWAITING_BOLT11                — fallback: seller provides a BOLT11 invoice
 */
const conversationState = new Map();

function clearState(telegramId) {
  conversationState.delete(String(telegramId));
}

function setState(telegramId, step, data = {}) {
  const existing = conversationState.get(String(telegramId)) ?? { data: {} };
  conversationState.set(String(telegramId), {
    step,
    data: { ...existing.data, ...data },
  });
}

function getState(telegramId) {
  return conversationState.get(String(telegramId)) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegraf bot
// ─────────────────────────────────────────────────────────────────────────────

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN, {
  telegram: { webhookReply: true },
});

// ─────────────────────────────────────────────────────────────────────────────
// Global middleware: upsert user on every update
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (ctx.from) {
    try {
      await upsertUser(ctx.from.id, ctx.from.username);
    } catch (err) {
      console.error('[middleware] upsertUser failed:', err.message);
    }
  }
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared UI helpers
// ─────────────────────────────────────────────────────────────────────────────

async function sendMainMenu(ctx) {
  await ctx.reply(
    '⚡ *Lightning Escrow Bot*\n\nSecure, trustless escrow powered by the Bitcoin Lightning Network.',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🆕 New Escrow',            'menu:new_escrow')],
        [Markup.button.callback('📋 My Escrows',            'menu:my_escrows')],
        [Markup.button.callback('📬 Set Lightning Address', 'menu:set_ln_address')],
        [Markup.button.callback('ℹ️ How it Works',          'menu:help')],
      ]),
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// /start — entry point + deep-link handler
// ─────────────────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const payload = ctx.startPayload;

  // Deep-link: /start escrow_<UUID>
  if (payload && payload.startsWith(DEEP_LINK_PREFIX)) {
    return handleEscrowInvite(ctx, payload.slice(DEEP_LINK_PREFIX.length));
  }

  clearState(ctx.from.id);
  const safeName = escapeMd(ctx.from.first_name);
  await ctx.reply(`👋 Welcome${safeName ? `, ${safeName}` : ''}!`, { parse_mode: 'Markdown' });
  return sendMainMenu(ctx);
});

// ─────────────────────────────────────────────────────────────────────────────
// Deep-link: show invite details and Accept / Decline buttons
// ─────────────────────────────────────────────────────────────────────────────

async function handleEscrowInvite(ctx, escrowId) {
  try {
    const escrow = await getEscrowById(escrowId);

    if (escrow.state !== 'CREATED')                   return ctx.reply('⚠️ This escrow is no longer accepting a counterparty.');
    if (escrow.creator_id === String(ctx.from.id))    return ctx.reply('🚫 You cannot join your own escrow.');
    if (escrow.invitee_id)                            return ctx.reply('⚠️ This escrow already has a counterparty.');

    const inviteeRole     = escrow.creator_role === 'Buyer' ? 'Seller' : 'Buyer';
    const creatorHandle   = escapeMd(escrow.creator?.username ? `@${escrow.creator.username}` : `User ${escrow.creator_id}`);
    const safeDesc        = escapeMd(escrow.trade_description);

    // Fee split preview
    const totalFeeSats    = escrow.platform_fee_sats;
    const { buyerFeeSats, sellerFeeSats } = splitPlatformFee(totalFeeSats);
    const inviteeFeeSats  = inviteeRole === 'Buyer' ? buyerFeeSats : sellerFeeSats;

    const amountKes       = await satsToKes(escrow.amount_sats);
    const inviteFeeKes    = await satsToKes(inviteeFeeSats);

    // Show the invitee only what is relevant to their role.
    const feeLineForRole  = inviteeRole === 'Buyer'
      ? `*Your fee share:* ${buyerFeeSats.toLocaleString()} sats (~KES ${inviteFeeKes.toLocaleString()}) _added to your payment_`
      : `*Your fee share:* ${sellerFeeSats.toLocaleString()} sats (~KES ${inviteFeeKes.toLocaleString()}) _deducted from your payout_`;

    const receiveOrPay    = inviteeRole === 'Buyer'
      ? `*You will pay:* ${(escrow.amount_sats + buyerFeeSats).toLocaleString()} sats total`
      : `*You will receive:* ${(escrow.amount_sats - sellerFeeSats).toLocaleString()} sats net`;

    await ctx.reply(
      `📩 *Escrow Invite*\n\n` +
      `You have been invited to join as the *${inviteeRole}*.\n\n` +
      `*Trade:* ${safeDesc}\n` +
      `*Trade Amount:* ${escrow.amount_sats.toLocaleString()} sats (~KES ${amountKes.toLocaleString()})\n` +
      `${feeLineForRole}\n` +
      `${receiveOrPay}\n\n` +
      `*Created by:* ${creatorHandle}\n\n` +
      `Do you want to accept this trade?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Accept',  `invite:accept:${escrowId}`),
            Markup.button.callback('❌ Decline', `invite:decline:${escrowId}`),
          ],
        ]),
      }
    );
  } catch (err) {
    if (err instanceof NotFoundError) return ctx.reply('❌ Escrow not found. The link may be invalid or expired.');
    console.error('[handleEscrowInvite]', err);
    return ctx.reply('❌ Something went wrong. Please try again later.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main menu handlers
// ─────────────────────────────────────────────────────────────────────────────

bot.action('menu:help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    '📖 *How Lightning Escrow Works*\n\n' +
    '1️⃣ The *Buyer* creates an escrow and shares the invite link with the Seller.\n' +
    '2️⃣ The *Seller* accepts the invite (a Lightning Address is required).\n' +
    '3️⃣ The *Buyer* pays the Lightning invoice to fund the escrow.\n' +
    '4️⃣ Once funded, the Seller delivers the goods or service.\n' +
    '5️⃣ The *Buyer* confirms receipt → funds are released to the Seller.\n' +
    '6️⃣ Disputes are reviewed and resolved by our admin team.\n\n' +
    `*Fee:* ${config.PLATFORM_FEE_PERCENTAGE * 100}% of the trade amount, split equally between Buyer and Seller.`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('menu:set_ln_address', async (ctx) => {
  await ctx.answerCbQuery();
  setState(ctx.from.id, 'AWAITING_LN_ADDRESS');
  await ctx.reply(
    '📬 Please send your Lightning Address (e.g. `alice@blink.sv`).\n' +
    'This is where payouts will be sent automatically.',
    { parse_mode: 'Markdown' }
  );
});

bot.action('menu:new_escrow', async (ctx) => {
  await ctx.answerCbQuery();
  setState(ctx.from.id, 'ESCROW_AWAITING_ROLE');
  await ctx.reply(
    '🆕 *New Escrow*\n\nWhat role are you in this trade?',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🛒 Buyer  (I am paying)',    'escrow:role:Buyer'),
          Markup.button.callback('📦 Seller (I am receiving)', 'escrow:role:Seller'),
        ],
        [Markup.button.callback('🔙 Cancel', 'escrow:cancel')],
      ]),
    }
  );
});

bot.action(/^escrow:role:(Buyer|Seller)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const role = ctx.match[1];
  setState(ctx.from.id, 'ESCROW_AWAITING_AMOUNT', { role });
  await ctx.reply(
    `✅ Role set: *${role}*\n\nHow much is this trade for in KES?\n_(Send just the number, e.g. \`5000\`)_`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('escrow:cancel', async (ctx) => {
  await ctx.answerCbQuery();
  clearState(ctx.from.id);
  await ctx.reply('❌ Escrow creation cancelled.');
  return sendMainMenu(ctx);
});

bot.action('menu:my_escrows', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    const { supabase } = require('./services/supabase');
    const { data: escrows, error } = await supabase
      .from('escrows')
      .select('*')
      .or(`creator_id.eq.${ctx.from.id},invitee_id.eq.${ctx.from.id}`)
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) throw error;
    if (!escrows?.length) return ctx.reply("You don't have any escrows yet. Create one with /start!");

    const lines = await Promise.all(escrows.map(async (e) => {
      const kes = await satsToKes(e.amount_sats);
      return `• \`${e.escrow_id.slice(0, 8)}…\` | ${e.state} | ${e.amount_sats.toLocaleString()} sats (~KES ${kes.toLocaleString()})`;
    }));

    await ctx.reply(`📋 *Your Recent Escrows*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('[menu:my_escrows]', err);
    await ctx.reply('❌ Failed to load escrows.');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INVITE: Accept flow
//
// Architecture (v2):
//   Step A — button press:
//     Determine the accepting user's role.
//     If they are the SELLER and have no saved LN address → pause here,
//     set state AWAITING_UPFRONT_LN_ADDRESS, prompt for address.
//     Otherwise → call completeEscrowAcceptance() immediately.
//
//   Step B — text handler (AWAITING_UPFRONT_LN_ADDRESS):
//     Validate + save the address, then call completeEscrowAcceptance().
//
//   completeEscrowAcceptance():
//     Sets invitee, transitions state, generates invoice, sends QR to BUYER
//     only, sends plain confirmation to SELLER only.
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^invite:accept:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Processing…');
  const escrowId = ctx.match[1];

  try {
    const escrow = await getEscrowById(escrowId);

    // Validation guards (same as shown in the invite message)
    if (escrow.state !== 'CREATED')                return ctx.editMessageText('⚠️ This escrow is no longer available.');
    if (escrow.creator_id === String(ctx.from.id)) return ctx.editMessageText('🚫 You cannot join your own escrow.');
    if (escrow.invitee_id)                         return ctx.editMessageText('⚠️ This escrow already has a counterparty.');

    const acceptingRole = escrow.creator_role === 'Buyer' ? 'Seller' : 'Buyer';

    // ── SELLER path: check for LN address before going further ───────────────
    if (acceptingRole === 'Seller') {
      const seller = await getUserByTelegramId(ctx.from.id);

      if (!seller.default_ln_address) {
        // Pause the flow — we need the address before we can generate the invoice.
        setState(ctx.from.id, 'AWAITING_UPFRONT_LN_ADDRESS', { escrowId });
        await ctx.editMessageText(
          '📬 *One more step before you accept.*\n\n' +
          'Please provide your Lightning Address (e.g. `username@blink.sv`).\n\n' +
          'This is where your funds will be sent automatically when the buyer releases them.',
          { parse_mode: 'Markdown' }
        );
        return;
      }
    }

    // ── BUYER path (or SELLER who already has an address): accept immediately ─
    await completeEscrowAcceptance(ctx, escrowId);

  } catch (err) {
    if (err instanceof StateConflictError) return ctx.editMessageText('⚠️ This escrow is no longer available.');
    console.error('[invite:accept]', err);
    await ctx.editMessageText('❌ Failed to process your acceptance. Please try again.');
  }
});

bot.action(/^invite:decline:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('❌ You declined the escrow invite.');
});

// ─────────────────────────────────────────────────────────────────────────────
// completeEscrowAcceptance
//
// The shared "second half" of the invite-accept flow. Called from:
//   • invite:accept handler (when seller already has an LN address, or for buyer)
//   • AWAITING_UPFRONT_LN_ADDRESS text handler (after address is saved)
//
// STRICT INVOICE ROUTING:
//   QR image + lnbc… invoice string → BUYER only.
//   Seller receives a plain confirmation message only.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Complete the escrow acceptance: set invitee, transition to PENDING_FUNDING,
 * generate the Lightning invoice, and notify both parties.
 *
 * @param {import('telegraf').Context} ctx  - Telegraf context of the ACCEPTING user.
 * @param {string} escrowId                 - UUID of the escrow being accepted.
 */
async function completeEscrowAcceptance(ctx, escrowId) {
  // Claim the invitee slot (validates state internally).
  await setEscrowInvitee(escrowId, ctx.from.id);

  // Transition CREATED → PENDING_FUNDING.
  const escrow = await transitionEscrowState(escrowId, 'CREATED', 'PENDING_FUNDING');

  // ── Fee split ──────────────────────────────────────────────────────────────
  const { buyerFeeSats, sellerFeeSats } = splitPlatformFee(escrow.platform_fee_sats);

  const buyerTelegramId  = escrow.creator_role === 'Buyer' ? escrow.creator_id : escrow.invitee_id;
  const sellerTelegramId = escrow.creator_role === 'Seller' ? escrow.creator_id : escrow.invitee_id;

  // What the buyer actually pays into the escrow (funds the entire trade amount
  // plus the buyer's half of the fee).
  const invoiceAmountSats = escrow.amount_sats + buyerFeeSats;

  // What the seller will receive when funds are released.
  const sellerPayoutSats  = escrow.amount_sats - sellerFeeSats;

  // ── Generate the Lightning invoice ─────────────────────────────────────────
  const { paymentHash, paymentRequest } = await createLightningInvoice({
    amountSats: invoiceAmountSats,
    memo:       `Escrow ${escrowId.slice(0, 8)} — ${escrow.trade_description}`,
  });

  // Stamp the payment hash atomically (PENDING_FUNDING self-transition).
  await transitionEscrowState(escrowId, 'PENDING_FUNDING', 'PENDING_FUNDING', {
    blink_payment_hash: paymentHash,
  });

  // ── KES display values ─────────────────────────────────────────────────────
  const tradeKes          = await satsToKes(escrow.amount_sats);
  const buyerFeeKes       = await satsToKes(buyerFeeSats);
  const sellerFeeKes      = await satsToKes(sellerFeeSats);
  const invoiceKes        = await satsToKes(invoiceAmountSats);
  const payoutKes         = await satsToKes(sellerPayoutSats);
  const safeDesc          = escapeMd(escrow.trade_description);

  // ── BUYER: QR code + invoice string ────────────────────────────────────────
  const qrBuffer = await QRCode.toBuffer(paymentRequest.toUpperCase(), {
    type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 512,
  });

  const invoiceCaption =
    `⚡ *Payment Invoice — Escrow Funding*\n\n` +
    `*Trade:* ${safeDesc}\n\n` +
    `*Trade amount:* ${escrow.amount_sats.toLocaleString()} sats (~KES ${tradeKes.toLocaleString()})\n` +
    `*Your fee share (½):* ${buyerFeeSats.toLocaleString()} sats (~KES ${buyerFeeKes.toLocaleString()})\n` +
    `*─────────────────────────*\n` +
    `*Total you pay:* ${invoiceAmountSats.toLocaleString()} sats (~KES ${invoiceKes.toLocaleString()})\n\n` +
    `Scan the QR code or copy the invoice below, then tap *Check Payment Status* once paid.`;

  // Send QR photo to the buyer.
  await bot.telegram.sendPhoto(
    buyerTelegramId,
    { source: qrBuffer },
    {
      caption:    invoiceCaption,
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Check Payment Status', `check:${escrowId}`)],
      ]),
    }
  );

  // Send the raw invoice string as a separate message so the buyer can copy it easily.
  await bot.telegram.sendMessage(
    buyerTelegramId,
    `\`${paymentRequest}\``,
    { parse_mode: 'Markdown' }
  );

  // ── SELLER: plain confirmation only — NO invoice data ──────────────────────
  await bot.telegram.sendMessage(
    sellerTelegramId,
    `✅ *You have accepted the trade!*\n\n` +
    `*Trade:* ${safeDesc}\n` +
    `*Trade amount:* ${escrow.amount_sats.toLocaleString()} sats (~KES ${tradeKes.toLocaleString()})\n` +
    `*Your fee share (½):* ${sellerFeeSats.toLocaleString()} sats (~KES ${sellerFeeKes.toLocaleString()})\n` +
    `*─────────────────────────*\n` +
    `*You will receive:* ${sellerPayoutSats.toLocaleString()} sats (~KES ${payoutKes.toLocaleString()})\n\n` +
    `Waiting for the buyer to fund the escrow. You will be notified once it is confirmed.`,
    { parse_mode: 'Markdown' }
  );

  // ── Confirm to the accepting user in the original chat ─────────────────────
  // If the accepting user is the buyer (creator role Buyer accepted their own
  // link — which can't happen — guard is already above; this covers Buyer as
  // invitee in a Seller-created escrow).
  try {
    await ctx.reply(
      `✅ *Escrow accepted!* Both parties have been notified.`,
      { parse_mode: 'Markdown' }
    );
  } catch {
    // If the context is a callback_query, editMessageText is safer.
    await ctx.editMessageText('✅ *Escrow accepted!* Both parties have been notified.', {
      parse_mode: 'Markdown',
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Check payment status (buyer polls after paying invoice)
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^check:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Checking…');
  const escrowId = ctx.match[1];

  try {
    const escrow = await getEscrowById(escrowId);

    if (escrow.state !== 'PENDING_FUNDING') {
      return ctx.reply(`ℹ️ Escrow is currently in state: *${escrow.state}*`, { parse_mode: 'Markdown' });
    }

    const { status } = await getInvoiceStatus(escrow.blink_payment_hash);

    if (status === 'PAID') {
      await transitionEscrowState(escrowId, 'PENDING_FUNDING', 'FUNDED');
      await notifyEscrowFunded(escrow);
      return ctx.reply('✅ *Payment confirmed! Escrow is now FUNDED.*', { parse_mode: 'Markdown' });
    }

    if (status === 'EXPIRED') {
      await transitionEscrowState(escrowId, 'PENDING_FUNDING', 'CANCELLED');
      return ctx.reply('⏰ Invoice has expired. The escrow has been cancelled.');
    }

    await ctx.reply(
      '⏳ Payment not yet received. Please pay the invoice and check again.',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Check Again', `check:${escrowId}`)]])
    );
  } catch (err) {
    console.error('[check payment]', err);
    await ctx.reply('❌ Failed to check payment status. Please try again.');
  }
});

/**
 * Notify both parties when an escrow transitions to FUNDED.
 * Shows each party their personalised fee split and net figures.
 *
 * @param {object} escrow - Full escrow row (invitee_id will be set by now).
 */
async function notifyEscrowFunded(escrow) {
  const sellerTelegramId = escrow.creator_role === 'Seller' ? escrow.creator_id : escrow.invitee_id;
  const buyerTelegramId  = escrow.creator_role === 'Buyer'  ? escrow.creator_id : escrow.invitee_id;

  const { buyerFeeSats, sellerFeeSats } = splitPlatformFee(escrow.platform_fee_sats);
  const sellerPayoutSats  = escrow.amount_sats - sellerFeeSats;

  const tradeKes          = await satsToKes(escrow.amount_sats);
  const payoutKes         = await satsToKes(sellerPayoutSats);
  const safeDesc          = escapeMd(escrow.trade_description);

  const releaseKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Release Funds', `release:${escrow.escrow_id}`)],
    [Markup.button.callback('⚠️ Open Dispute',  `dispute:${escrow.escrow_id}`)],
  ]);

  // Buyer: they already paid, now they wait for delivery.
  await bot.telegram.sendMessage(
    buyerTelegramId,
    `✅ *Escrow Funded!*\n\n` +
    `*Trade:* ${safeDesc}\n` +
    `*Trade amount:* ${escrow.amount_sats.toLocaleString()} sats (~KES ${tradeKes.toLocaleString()})\n\n` +
    `Once you receive the goods or service, press *Release Funds*.\n` +
    `If there is a problem, press *Open Dispute*.`,
    { parse_mode: 'Markdown', ...releaseKeyboard }
  );

 // Seller: tells them exactly what they will receive upon release, with a Shipped button.
  const sellerKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📦 Mark as Delivered/Shipped', `shipped:${escrow.escrow_id}`)]
  ]);

  await bot.telegram.sendMessage(
    sellerTelegramId,
    `✅ *Escrow is Funded!*\n\n` +
    `*Trade:* ${safeDesc}\n` +
    `*You will receive:* ${sellerPayoutSats.toLocaleString()} sats (~KES ${payoutKes.toLocaleString()})\n\n` +
    `Please fulfil your end of the trade, then click the button below to notify the buyer.`,
    { parse_mode: 'Markdown', ...sellerKeyboard }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Seller marks as shipped / delivered
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^shipped:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Notifying buyer…');
  const escrowId = ctx.match[1];

  try {
    const escrow = await getEscrowById(escrowId);

    const sellerTelegramId = escrow.creator_role === 'Seller' ? escrow.creator_id : escrow.invitee_id;
    const buyerTelegramId  = escrow.creator_role === 'Buyer'  ? escrow.creator_id : escrow.invitee_id;

    if (String(ctx.from.id) !== String(sellerTelegramId)) {
      return ctx.answerCbQuery('Only the seller can mark this as shipped.', { show_alert: true });
    }

    if (escrow.state !== 'FUNDED') {
      return ctx.answerCbQuery(`Escrow is currently: ${escrow.state}`, { show_alert: true });
    }

    const safeDesc = escapeMd(escrow.trade_description);

    // Give the buyer the release/dispute buttons again for easy access
    const releaseKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('✅ Release Funds', `release:${escrow.escrow_id}`)],
      [Markup.button.callback('⚠️ Open Dispute',  `dispute:${escrow.escrow_id}`)],
    ]);

    // 1. Notify the Buyer
    await bot.telegram.sendMessage(
      buyerTelegramId,
      `📦 *Order Fulfilled!*\n\n` +
      `The seller has marked the following trade as delivered/shipped:\n` +
      `_Trade: ${safeDesc}_\n\n` +
      `Please verify you received what you paid for. If everything looks good, release the funds.`,
      { parse_mode: 'Markdown', ...releaseKeyboard }
    );

    // 2. Update the Seller's UI so they know it worked
    await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([
      [Markup.button.callback('✅ Marked as Shipped (Waiting for Buyer)', 'noop')]
    ]).reply_markup);

  } catch (err) {
    console.error('[shipped action]', err);
    await ctx.answerCbQuery('❌ Failed to notify buyer.', { show_alert: true });
  }
});

// A dummy action for the disabled button so it doesn't throw an error if clicked again
bot.action('noop', async (ctx) => {
  await ctx.answerCbQuery();
});

// ─────────────────────────────────────────────────────────────────────────────
// Release funds (buyer confirms delivery → pay seller)
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^release:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Processing payout…');
  const escrowId = ctx.match[1];

  try {
    const escrow = await getEscrowById(escrowId);

    const buyerTelegramId  = escrow.creator_role === 'Buyer'  ? escrow.creator_id : escrow.invitee_id;
    const sellerTelegramId = escrow.creator_role === 'Seller' ? escrow.creator_id : escrow.invitee_id;

    if (String(ctx.from.id) !== String(buyerTelegramId)) {
      return ctx.answerCbQuery('Only the buyer can release funds.', { show_alert: true });
    }
    if (escrow.state !== 'FUNDED') {
      return ctx.answerCbQuery(`Escrow is currently in state: ${escrow.state}`, { show_alert: true });
    }

    // Atomic state lock: FUNDED → SETTLED.
    // After this point the buyer cannot un-release.  payout_successful stays
    // false until the Lightning payment is confirmed below.
    await transitionEscrowState(escrowId, 'FUNDED', 'SETTLED');

    const { sellerFeeSats }  = splitPlatformFee(escrow.platform_fee_sats);
    const sellerPayoutSats   = escrow.amount_sats - sellerFeeSats;
    const payoutKes          = await satsToKes(sellerPayoutSats);
    const safeDesc           = escapeMd(escrow.trade_description);

    const seller = await getUserByTelegramId(sellerTelegramId);
    const memo   = `Escrow settlement: ${escrow.trade_description}`;

    // ── Primary payout path: Lightning Address ──────────────────────────────
    if (seller.default_ln_address) {
      try {
        await payToLightningAddress({
          lnAddress:  seller.default_ln_address,
          amountSats: sellerPayoutSats,
          memo,
        });

        // Payment confirmed — mark payout successful in DB.
        await setPayoutSuccessful(escrowId);
        await incrementCompletedTrades(String(escrow.creator_id));
        await incrementCompletedTrades(String(escrow.invitee_id));

        const safeLn = escapeMd(seller.default_ln_address);
        await ctx.editMessageText(
          `✅ *Funds Released!*\n\n` +
          `${sellerPayoutSats.toLocaleString()} sats (~KES ${payoutKes.toLocaleString()}) sent to ${safeLn}`,
          { parse_mode: 'Markdown' }
        );
        await bot.telegram.sendMessage(
          sellerTelegramId,
          `🎉 *Payment received!*\n\n` +
          `${sellerPayoutSats.toLocaleString()} sats (~KES ${payoutKes.toLocaleString()}) have been sent to your Lightning Address.\n` +
          `_Trade: ${safeDesc}_`,
          { parse_mode: 'Markdown' }
        );
        return;

      } catch (payErr) {
        if (payErr instanceof LnAddressPayoutError) {
          // Primary path failed — fall through to BOLT11 fallback.
          console.warn('[release] LN Address payout failed, falling back to BOLT11:', payErr.message);
        } else {
          throw payErr;
        }
      }
    }

    // ── Fallback path: request a BOLT11 invoice from the seller ────────────
    // payout_successful remains false; the recovery routine will also catch
    // this if the bot restarts before the seller provides an invoice.
    setState(sellerTelegramId, 'AWAITING_BOLT11', { escrowId, amountSats: sellerPayoutSats });
    await bot.telegram.sendMessage(
      sellerTelegramId,
      `💸 *Payout Ready — Action Required*\n\n` +
      `${sellerPayoutSats.toLocaleString()} sats (~KES ${payoutKes.toLocaleString()}) are waiting for you.\n\n` +
      `⚠️ Automatic payout to your Lightning Address failed.\n` +
      `Please paste a BOLT11 invoice for *${sellerPayoutSats.toLocaleString()} sats* to receive your funds.\n\n` +
      `_(Generate one in your Lightning wallet app.)_`,
      { parse_mode: 'Markdown' }
    );
    await ctx.editMessageText(
      '✅ Funds released. The seller has been asked to provide a payment invoice.'
    );

  } catch (err) {
    if (err instanceof StateConflictError) return ctx.editMessageText('⚠️ This action was already completed.');
    console.error('[release funds]', err);
    await ctx.editMessageText('❌ Payout failed. Please contact support.');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Dispute flow
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^dispute:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Opening dispute…');
  const escrowId = ctx.match[1];

  try {
    const escrow = await getEscrowById(escrowId);

    if (escrow.state !== 'FUNDED') {
      return ctx.answerCbQuery('Disputes can only be opened on a funded escrow.', { show_alert: true });
    }

    await transitionEscrowState(escrowId, 'FUNDED', 'DISPUTED');
    await incrementDisputedTrades(String(escrow.creator_id));
    if (escrow.invitee_id) await incrementDisputedTrades(String(escrow.invitee_id));

    await ctx.editMessageText(
      '⚠️ *Dispute Opened*\n\n' +
      'Our admin team has been notified and will review your case.\n' +
      'Please do not take any further action.',
      { parse_mode: 'Markdown' }
    );

    await sendDisputeDossier(escrow, ctx.from);

  } catch (err) {
    if (err instanceof StateConflictError) return ctx.editMessageText('⚠️ Escrow state changed — dispute may already be open.');
    console.error('[dispute]', err);
    await ctx.editMessageText('❌ Failed to open dispute. Please contact support directly.');
  }
});

/**
 * Send the admin dossier with Payout Seller / Refund Buyer buttons.
 *
 * @param {object} escrow
 * @param {object} initiator - ctx.from of the user who pressed Open Dispute.
 */
async function sendDisputeDossier(escrow, initiator) {
  const creatorHandle   = escapeMd(escrow.creator?.username  ? `@${escrow.creator.username}`  : escrow.creator_id);
  const inviteeHandle   = escapeMd(escrow.invitee?.username  ? `@${escrow.invitee.username}`  : (escrow.invitee_id ?? 'N/A'));
  const initiatorHandle = escapeMd(initiator.username ? `@${initiator.username}` : `User ${initiator.id}`);
  const safeDesc        = escapeMd(escrow.trade_description);

  const { buyerFeeSats, sellerFeeSats } = splitPlatformFee(escrow.platform_fee_sats);
  const sellerPayoutSats = escrow.amount_sats - sellerFeeSats;
 // Buyer gets their trade amount MINUS the total platform fee
  const buyerRefundSats  = escrow.amount_sats - escrow.platform_fee_sats;

  const amountKes   = await satsToKes(escrow.amount_sats);
  const payoutKes   = await satsToKes(sellerPayoutSats);
  const refundKes   = await satsToKes(buyerRefundSats);

  const dossier =
    `🚨 *DISPUTE DOSSIER* 🚨\n\n` +
    `*Escrow ID:* \`${escrow.escrow_id}\`\n` +
    `*Trade:* ${safeDesc}\n` +
    `*Trade Amount:* ${escrow.amount_sats.toLocaleString()} sats (~KES ${amountKes.toLocaleString()})\n\n` +
    `*Creator (${escrow.creator_role}):* ${creatorHandle}\n` +
    `*Counterparty (${escrow.creator_role === 'Buyer' ? 'Seller' : 'Buyer'}):* ${inviteeHandle}\n\n` +
    `*Dispute opened by:* ${initiatorHandle}\n` +
    `*Payment Hash:* \`${escrow.blink_payment_hash ?? 'N/A'}\`\n\n` +
    `*If you pay Seller:* ${sellerPayoutSats.toLocaleString()} sats (~KES ${payoutKes.toLocaleString()})\n` +
    `*If you refund Buyer:* ${buyerRefundSats.toLocaleString()} sats (~KES ${refundKes.toLocaleString()})\n\n` +
    `Please investigate and resolve using the buttons below.`;

  await bot.telegram.sendMessage(config.ADMIN_TELEGRAM_ID, dossier, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('💸 Payout Seller', `admin:payout:${escrow.escrow_id}`),
        Markup.button.callback('↩️ Refund Buyer',  `admin:refund:${escrow.escrow_id}`),
      ],
    ]),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin actions
// ─────────────────────────────────────────────────────────────────────────────

function isAdmin(ctx) {
  return String(ctx.from.id) === config.ADMIN_TELEGRAM_ID;
}

bot.action(/^admin:payout:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('🚫 Unauthorised.', { show_alert: true });
  await ctx.answerCbQuery('Processing payout to seller…');
  const escrowId = ctx.match[1];

  try {
    const escrow = await getEscrowById(escrowId);
    await transitionEscrowState(escrowId, 'DISPUTED', 'SETTLED');

    const sellerTelegramId = escrow.creator_role === 'Seller' ? escrow.creator_id : escrow.invitee_id;
    const buyerTelegramId  = escrow.creator_role === 'Buyer'  ? escrow.creator_id : escrow.invitee_id;
    const seller           = await getUserByTelegramId(sellerTelegramId);
    const memo             = `Admin-resolved escrow: ${escrow.trade_description}`;

    const { sellerFeeSats }  = splitPlatformFee(escrow.platform_fee_sats);
    const sellerPayoutSats   = escrow.amount_sats - sellerFeeSats;
    const payoutKes          = await satsToKes(sellerPayoutSats);

    if (seller.default_ln_address) {
      await payToLightningAddress({ lnAddress: seller.default_ln_address, amountSats: sellerPayoutSats, memo });
      await setPayoutSuccessful(escrowId);
    } else {
      setState(sellerTelegramId, 'AWAITING_BOLT11', { escrowId, amountSats: sellerPayoutSats });
      await bot.telegram.sendMessage(
        sellerTelegramId,
        `💸 The admin has resolved the dispute in your favour!\n` +
        `Please paste a BOLT11 invoice for *${sellerPayoutSats.toLocaleString()} sats* (~KES ${payoutKes.toLocaleString()}) to receive your payout.`,
        { parse_mode: 'Markdown' }
      );
    }

    await incrementCompletedTrades(String(escrow.creator_id));
    await ctx.editMessageText(`✅ Admin Resolved: Funds paid out to Seller.\nEscrow: \`${escrowId}\``, { parse_mode: 'Markdown' });

    await bot.telegram.sendMessage(buyerTelegramId,  '⚖️ The admin has resolved the dispute. Funds have been released to the Seller.');
    await bot.telegram.sendMessage(sellerTelegramId, '⚖️ The admin resolved the dispute in your favour. Payout is on its way!');

  } catch (err) {
    console.error('[admin:payout]', err);
    await ctx.editMessageText('❌ Payout failed: ' + err.message);
  }
});

bot.action(/^admin:refund:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('🚫 Unauthorised.', { show_alert: true });
  await ctx.answerCbQuery('Processing refund to buyer…');
  const escrowId = ctx.match[1];

  try {
    const escrow = await getEscrowById(escrowId);
    await transitionEscrowState(escrowId, 'DISPUTED', 'CANCELLED');

    const buyerTelegramId  = escrow.creator_role === 'Buyer'  ? escrow.creator_id : escrow.invitee_id;
    const sellerTelegramId = escrow.creator_role === 'Seller' ? escrow.creator_id : escrow.invitee_id;
    const buyer            = await getUserByTelegramId(buyerTelegramId);
    const memo             = `Admin-ordered refund: ${escrow.trade_description}`;

    // Full refund = what the buyer originally paid (amount + buyer's fee half).
    const { buyerFeeSats }  = splitPlatformFee(escrow.platform_fee_sats);
    const refundSats        = escrow.amount_sats + buyerFeeSats;
    const refundKes         = await satsToKes(refundSats);

    if (buyer.default_ln_address) {
      await payToLightningAddress({ lnAddress: buyer.default_ln_address, amountSats: refundSats, memo });
      await setPayoutSuccessful(escrowId);
    } else {
      setState(buyerTelegramId, 'AWAITING_BOLT11', { escrowId, amountSats: refundSats });
      await bot.telegram.sendMessage(
        buyerTelegramId,
        `↩️ The admin has ordered a refund in your favour!\n` +
        `Please paste a BOLT11 invoice for *${refundSats.toLocaleString()} sats* (~KES ${refundKes.toLocaleString()}).`,
        { parse_mode: 'Markdown' }
      );
    }

    await ctx.editMessageText(`✅ Admin Resolved: Refund issued to Buyer.\nEscrow: \`${escrowId}\``, { parse_mode: 'Markdown' });

    await bot.telegram.sendMessage(buyerTelegramId,  '⚖️ The admin resolved the dispute in your favour. A refund is on its way.');
    if (sellerTelegramId) {
      await bot.telegram.sendMessage(sellerTelegramId, '⚖️ The admin reviewed the dispute and ordered a refund to the Buyer.');
    }

  } catch (err) {
    console.error('[admin:refund]', err);
    await ctx.editMessageText('❌ Refund failed: ' + err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Text message handler — drives multi-step conversation flows
// ─────────────────────────────────────────────────────────────────────────────

bot.on('text', async (ctx) => {
  const state = getState(ctx.from.id);
  const text  = ctx.message.text.trim();

  if (text.startsWith('/')) return; // let command handlers deal with it

  if (!state) return sendMainMenu(ctx);

  // ── AWAITING_LN_ADDRESS — user setting their default address ───────────────
  if (state.step === 'AWAITING_LN_ADDRESS') {
    if (!text.includes('@') || text.includes(' ')) {
      return ctx.reply('❌ Invalid format. Please send a Lightning Address like `alice@blink.sv`', { parse_mode: 'Markdown' });
    }
    try {
      await setDefaultLnAddress(ctx.from.id, text.toLowerCase());
      clearState(ctx.from.id);
      await ctx.reply(`✅ Lightning Address saved: \`${text.toLowerCase()}\``, { parse_mode: 'Markdown' });
      return sendMainMenu(ctx);
    } catch (err) {
      console.error('[set ln address]', err);
      return ctx.reply('❌ Failed to save. Please try again.');
    }
  }

  // ── AWAITING_UPFRONT_LN_ADDRESS — seller must provide address before accept ─
  if (state.step === 'AWAITING_UPFRONT_LN_ADDRESS') {
    if (!text.includes('@') || text.includes(' ')) {
      return ctx.reply(
        '❌ That doesn\'t look like a valid Lightning Address.\n' +
        'Please send one in the format `username@domain.com`.',
        { parse_mode: 'Markdown' }
      );
    }

    const lnAddress = text.toLowerCase();
    const { escrowId } = state.data;

    try {
      // Save the address to the user's profile.
      await setDefaultLnAddress(ctx.from.id, lnAddress);
      clearState(ctx.from.id);

      await ctx.reply(`✅ Lightning Address saved: \`${lnAddress}\`\n\nProcessing your acceptance now…`, { parse_mode: 'Markdown' });

      // Now fire the full acceptance flow with the address saved.
      await completeEscrowAcceptance(ctx, escrowId);

    } catch (err) {
      if (err instanceof StateConflictError) {
        return ctx.reply('⚠️ This escrow is no longer available.');
      }
      console.error('[AWAITING_UPFRONT_LN_ADDRESS]', err);
      clearState(ctx.from.id);
      return ctx.reply('❌ Something went wrong. Please try again or contact support.');
    }
    return;
  }

  // ── ESCROW_AWAITING_AMOUNT — step 2 of new escrow wizard ───────────────────
  if (state.step === 'ESCROW_AWAITING_AMOUNT') {
    const kesValue = parseInt(text.replace(/[^0-9]/g, ''), 10);
    if (isNaN(kesValue) || kesValue <= 0) {
      return ctx.reply('❌ Please enter a valid KES amount (e.g. `5000`).', { parse_mode: 'Markdown' });
    }

    try {
      const amountSats = await kesToSats(kesValue);
      if (isNaN(amountSats) || amountSats < 1000) {
        return ctx.reply('❌ Amount too low. The minimum escrow size is roughly KES 100 (1,000 sats).');
      }

      const totalFeeSats              = calculatePlatformFee(amountSats);
      const { buyerFeeSats, sellerFeeSats } = splitPlatformFee(totalFeeSats);

      const buyerFeeKes     = await satsToKes(buyerFeeSats);
      const sellerFeeKes    = await satsToKes(sellerFeeSats);
      const buyerTotalSats  = amountSats + buyerFeeSats;
      const sellerNetSats   = amountSats - sellerFeeSats;
      const buyerTotalKes   = await satsToKes(buyerTotalSats);
      const sellerNetKes    = await satsToKes(sellerNetSats);

      setState(ctx.from.id, 'ESCROW_AWAITING_DESCRIPTION', {
        amountSats,
        platformFeeSats: totalFeeSats,
      });

      await ctx.reply(
        `💰 *Trade Amount:* KES ${kesValue.toLocaleString()} (~${amountSats.toLocaleString()} sats)\n\n` +
        `*Fee Breakdown (${config.PLATFORM_FEE_PERCENTAGE * 100}% split 50/50):*\n` +
        `  🛒 Buyer pays fee: KES ${buyerFeeKes.toLocaleString()} (~${buyerFeeSats.toLocaleString()} sats)\n` +
        `  📦 Seller pays fee: KES ${sellerFeeKes.toLocaleString()} (~${sellerFeeSats.toLocaleString()} sats)\n\n` +
        `*Net result:*\n` +
        `  🛒 Buyer total invoice: KES ${buyerTotalKes.toLocaleString()} (~${buyerTotalSats.toLocaleString()} sats)\n` +
        `  📦 Seller net payout: KES ${sellerNetKes.toLocaleString()} (~${sellerNetSats.toLocaleString()} sats)\n\n` +
        `Now, please describe the trade (e.g. "1 month VPN subscription"):`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('[kes conversion]', err);
      return ctx.reply('❌ Failed to fetch the current exchange rate. Please try again.');
    }
    return;
  }

  // ── ESCROW_AWAITING_DESCRIPTION — step 3 of new escrow wizard ──────────────
  if (state.step === 'ESCROW_AWAITING_DESCRIPTION') {
    if (text.length < 5 || text.length > 200) {
      return ctx.reply('❌ Description must be between 5 and 200 characters.');
    }

    try {
      const escrow = await createEscrow({
        creatorId:        String(ctx.from.id),
        creatorRole:      state.data.role,
        amountSats:       state.data.amountSats,
        platformFeeSats:  state.data.platformFeeSats,
        tradeDescription: text,
      });

      clearState(ctx.from.id);

      const botUsername = ctx.botInfo?.username ?? 'this_bot';
      const inviteLink  = `https://t.me/${botUsername}?start=${DEEP_LINK_PREFIX}${escrow.escrow_id}`;

      const { buyerFeeSats, sellerFeeSats } = splitPlatformFee(escrow.platform_fee_sats);
      const amountKes   = await satsToKes(escrow.amount_sats);
      const safeDesc    = escapeMd(escrow.trade_description);
      const safeLink    = escapeMd(inviteLink);

      // Creator is told their own side of the fee split.
      const creatorFeeInfo = escrow.creator_role === 'Buyer'
        ? `Your fee share (½): ${buyerFeeSats.toLocaleString()} sats added to your payment`
        : `Your fee share (½): ${sellerFeeSats.toLocaleString()} sats deducted from your payout`;

      await ctx.reply(
        `✅ *Escrow Created!*\n\n` +
        `*ID:* \`${escrow.escrow_id.slice(0, 8)}…\`\n` +
        `*Your role:* ${escrow.creator_role}\n` +
        `*Trade amount:* ${escrow.amount_sats.toLocaleString()} sats (~KES ${amountKes.toLocaleString()})\n` +
        `*${creatorFeeInfo}*\n` +
        `*Trade:* ${safeDesc}\n\n` +
        `📤 *Share this link with your counterparty:*\n${safeLink}`,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );
    } catch (err) {
      console.error('[create escrow]', err);
      clearState(ctx.from.id);
      await ctx.reply('❌ Failed to create escrow. Please try again.');
    }
    return;
  }

  // ── AWAITING_BOLT11 — fallback payout: user provides a BOLT11 invoice ──────
  if (state.step === 'AWAITING_BOLT11') {
    if (!text.toLowerCase().startsWith('ln') || text.includes(' ')) {
      return ctx.reply("❌ That doesn't look like a valid BOLT11 invoice. Please try again.");
    }

    const { escrowId, amountSats } = state.data;

    try {
      await payBolt11Invoice({ paymentRequest: text, memo: `Escrow payout: ${escrowId}` });

      // Mark payout successful now that BOLT11 confirmed.
      await setPayoutSuccessful(escrowId);
      clearState(ctx.from.id);

      const amountKes = await satsToKes(amountSats);
      await ctx.reply(
        `✅ *Payment sent!*\n\n${amountSats.toLocaleString()} sats (~KES ${amountKes.toLocaleString()}) are on their way.`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('[bolt11 payout]', err);
      await ctx.reply(`❌ Payment failed: ${err.message}\n\nPlease paste a new BOLT11 invoice.`);
    }
    return;
  }

  // ── Fallback: no recognised state step ─────────────────────────────────────
  clearState(ctx.from.id);
  return sendMainMenu(ctx);
});

// ─────────────────────────────────────────────────────────────────────────────
// Global error handler
// ─────────────────────────────────────────────────────────────────────────────

bot.catch((err, ctx) => {
  console.error(`[bot] Unhandled error for update ${ctx.update?.update_id}:`, err);
  ctx.reply('⚠️ An unexpected error occurred. Please try again later.').catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// STARTUP RECOVERY — re-attempt payouts after a crash
//
// SCENARIO:
//   1. Buyer clicks "Release Funds".
//   2. Bot transitions escrow to SETTLED (atomic DB write — succeeds).
//   3. Bot crashes before the Blink API call returns.
//   4. On next startup, payout_successful is still false.
//   5. This routine finds those rows and re-attempts the payout automatically.
//
// ROUTING:
//   • Seller has a saved LN address → re-attempt payToLightningAddress.
//       Success: setPayoutSuccessful, notify seller.
//       Failure: message seller asking for a new address (sets AWAITING_BOLT11).
//   • Seller has no saved LN address → message seller asking them to provide one
//     so they can claim their trapped funds.
// ─────────────────────────────────────────────────────────────────────────────

async function recoverPendingPayouts() {
  let pendingEscrows;
  try {
    pendingEscrows = await getSettledUnpaidEscrows();
  } catch (err) {
    console.error('[recovery] Failed to query settled unpaid escrows:', err.message);
    return; // Non-fatal: don't block startup.
  }

  if (pendingEscrows.length === 0) {
    console.log('[recovery] No pending payouts found.');
    return;
  }

  console.log(`[recovery] Found ${pendingEscrows.length} settled escrow(s) with unpaid payouts. Re-attempting…`);

  for (const escrow of pendingEscrows) {
    const escrowId        = escrow.escrow_id;
    const sellerTelegramId = escrow.creator_role === 'Seller' ? escrow.creator_id : escrow.invitee_id;

    if (!sellerTelegramId) {
      console.warn(`[recovery] Escrow ${escrowId} has no invitee — skipping.`);
      continue;
    }

    const { sellerFeeSats }  = splitPlatformFee(escrow.platform_fee_sats);
    const sellerPayoutSats   = escrow.amount_sats - sellerFeeSats;

    let sellerUser;
    try {
      sellerUser = await getUserByTelegramId(sellerTelegramId);
    } catch (err) {
      console.error(`[recovery] Could not fetch seller for escrow ${escrowId}:`, err.message);
      continue;
    }

    const payoutKes = await satsToKes(sellerPayoutSats).catch(() => 0);
    const safeDesc  = escapeMd(escrow.trade_description);

    // ── Case 1: seller has a LN address — try to pay ─────────────────────────
    if (sellerUser.default_ln_address) {
      console.log(`[recovery] Retrying LN Address payout for escrow ${escrowId} → ${sellerUser.default_ln_address}`);
      try {
        await payToLightningAddress({
          lnAddress:  sellerUser.default_ln_address,
          amountSats: sellerPayoutSats,
          memo:       `Recovered escrow payout: ${escrow.trade_description}`,
        });

        await setPayoutSuccessful(escrowId);
        console.log(`[recovery] ✅ Payout recovered for escrow ${escrowId}`);

        // Notify the seller.
        await bot.telegram.sendMessage(
          sellerTelegramId,
          `🎉 *Your payment has arrived!*\n\n` +
          `${sellerPayoutSats.toLocaleString()} sats (~KES ${payoutKes.toLocaleString()}) from escrow trade "${safeDesc}" have been sent to your Lightning Address.\n\n` +
          `_(This was a delayed payout — apologies for any inconvenience.)_`,
          { parse_mode: 'Markdown' }
        ).catch((e) => console.error(`[recovery] Failed to notify seller ${sellerTelegramId}:`, e.message));

      } catch (payErr) {
        // LN Address retry also failed — ask seller for a fresh address.
        console.warn(`[recovery] LN Address retry failed for escrow ${escrowId}:`, payErr.message);

        setState(sellerTelegramId, 'AWAITING_BOLT11', { escrowId, amountSats: sellerPayoutSats });

        await bot.telegram.sendMessage(
          sellerTelegramId,
          `⚠️ *Funds Waiting — Action Required*\n\n` +
          `You have *${sellerPayoutSats.toLocaleString()} sats* (~KES ${payoutKes.toLocaleString()}) unclaimed from an escrow trade.\n\n` +
          `*Trade:* ${safeDesc}\n\n` +
          `Automatic payment to your Lightning Address failed. Please either:\n` +
          `• Update your Lightning Address via the menu and reply \`retry\`, or\n` +
          `• Paste a BOLT11 invoice for *${sellerPayoutSats.toLocaleString()} sats* below to claim your funds now.`,
          { parse_mode: 'Markdown' }
        ).catch((e) => console.error(`[recovery] Failed to message seller ${sellerTelegramId}:`, e.message));
      }

    // ── Case 2: no LN address on file — prompt the seller ────────────────────
    } else {
      console.warn(`[recovery] Seller ${sellerTelegramId} has no LN address for escrow ${escrowId}.`);

      setState(sellerTelegramId, 'AWAITING_BOLT11', { escrowId, amountSats: sellerPayoutSats });

      await bot.telegram.sendMessage(
        sellerTelegramId,
        `⚠️ *Unclaimed Funds — Action Required*\n\n` +
        `You have *${sellerPayoutSats.toLocaleString()} sats* (~KES ${payoutKes.toLocaleString()}) waiting from an escrow trade.\n\n` +
        `*Trade:* ${safeDesc}\n\n` +
        `No Lightning Address is saved on your account. Please paste a BOLT11 invoice for *${sellerPayoutSats.toLocaleString()} sats* below to claim your funds.`,
        { parse_mode: 'Markdown' }
      ).catch((e) => console.error(`[recovery] Failed to message seller ${sellerTelegramId}:`, e.message));
    }
  }

  console.log('[recovery] Recovery routine complete.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Express server + Telegram webhook
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

/** Health check — used by Railway's probe. */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Webhook endpoint.
 * Telegraf validates the X-Telegram-Bot-Api-Secret-Token header automatically.
 */
// Bulletproof explicit POST route for Telegram
app.post(WEBHOOK_PATH, (req, res, next) => {
  console.log('[webhook] Received update from Telegram!'); 
  return bot.webhookCallback(WEBHOOK_PATH, {
    secretToken: config.TELEGRAM_WEBHOOK_SECRET,
  })(req, res, next);
});

// Catch-all 404 handler for debugging
app.use((req, res) => {
  console.log(`[express] 404 Not Found on path: ${req.path}`);
  res.status(404).send('Not Found');
});

// ─────────────────────────────────────────────────────────────────────────────
// Startup sequence
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[startup] Environment validated ✓');

  console.log('[startup] Warming Blink wallet cache…');
  await initBlink();

  console.log('[startup] Running payout recovery routine…');
  await recoverPendingPayouts();

  console.log('[startup] Registering Telegram webhook…');
  const webhookUrl = `${config.WEBHOOK_DOMAIN}${WEBHOOK_PATH}`;
  await bot.telegram.setWebhook(webhookUrl, {
    secret_token:         config.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates:      ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  console.log(`[startup] Webhook registered: ${webhookUrl}`);

  app.listen(config.PORT, () => {
    console.log(`[startup] Express listening on port ${config.PORT}`);
    console.log('[startup] Bot is ready. ⚡');
  });
}

main().catch((err) => {
  console.error('[startup] FATAL:', err.message);
  process.exit(1);
});