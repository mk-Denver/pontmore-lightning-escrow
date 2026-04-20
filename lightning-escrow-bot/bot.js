/**
 * bot.js
 *
 * Entry point for the Telegram Lightning Escrow Bot.
 * System-wide Markdown Sanitization Applied.
 */

'use strict';

// ─── Fail-fast env validation (must be first) ────────────────────────────────
const { config, calculatePlatformFee } = require('./config/env');

// ─── Dependencies ─────────────────────────────────────────────────────────────
const express   = require('express');
const { Telegraf, Markup } = require('telegraf');
const QRCode    = require('qrcode');

// ─── Internal services ────────────────────────────────────────────────────────
const {
  upsertUser,
  getUserByTelegramId,
  setDefaultLnAddress,
  createEscrow,
  getEscrowById,
  setEscrowInvitee,
  transitionEscrowState,
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
// Constants & Utilities
// ─────────────────────────────────────────────────────────────────────────────

const WEBHOOK_PATH = `/telegram/${config.TELEGRAM_BOT_TOKEN.replace(':', '_')}`;
const DEEP_LINK_PREFIX = 'escrow_';

/**
 * Escapes characters that Telegram's Markdown (v1) parser treats as formatting.
 * Prevents "Can't find end of the entity" crashes from user input.
 */
function escapeMd(text) {
  if (!text) return '';
  return String(text).replace(/([_*`\[])/g, '\\$1');
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory conversation state store
// ─────────────────────────────────────────────────────────────────────────────

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
// Telegraf bot initialisation
// ─────────────────────────────────────────────────────────────────────────────

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN, {
  telegram: { webhookReply: true },
});

// ─────────────────────────────────────────────────────────────────────────────
// Middleware: upsert user on every interaction
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
// Helper: send the main menu
// ─────────────────────────────────────────────────────────────────────────────

async function sendMainMenu(ctx) {
  await ctx.reply(
    '⚡ *Lightning Escrow Bot*\n\nSecure, trustless escrow powered by the Bitcoin Lightning Network.',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🆕 New Escrow',         'menu:new_escrow')],
        [Markup.button.callback('📋 My Escrows',         'menu:my_escrows')],
        [Markup.button.callback('📬 Set Lightning Address', 'menu:set_ln_address')],
        [Markup.button.callback('ℹ️ How it Works',        'menu:help')],
      ]),
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// /start  —  Entry point + deep-link handler
// ─────────────────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const payload = ctx.startPayload; 

  if (payload && payload.startsWith(DEEP_LINK_PREFIX)) {
    const escrowId = payload.slice(DEEP_LINK_PREFIX.length);
    return handleEscrowInvite(ctx, escrowId);
  }

  clearState(ctx.from.id);
  const safeName = escapeMd(ctx.from.first_name);
  await ctx.reply(
    `👋 Welcome${safeName ? `, ${safeName}` : ''}!`,
    { parse_mode: 'Markdown' }
  );
  return sendMainMenu(ctx);
});

// ─────────────────────────────────────────────────────────────────────────────
// Deep-link: join an existing escrow as the counterparty
// ─────────────────────────────────────────────────────────────────────────────

async function handleEscrowInvite(ctx, escrowId) {
  try {
    const escrow = await getEscrowById(escrowId);

    if (escrow.state !== 'CREATED') {
      return ctx.reply('⚠️ This escrow is no longer accepting a counterparty.');
    }
    if (escrow.creator_id === String(ctx.from.id)) {
      return ctx.reply("🚫 You can't join your own escrow.");
    }
    if (escrow.invitee_id) {
      return ctx.reply('⚠️ This escrow already has a counterparty.');
    }

    const inviteeRole = escrow.creator_role === 'Buyer' ? 'Seller' : 'Buyer';
    const creatorHandle = escapeMd(escrow.creator?.username
      ? `@${escrow.creator.username}`
      : `User ${escrow.creator_id}`);
    
    const safeDesc = escapeMd(escrow.trade_description);
    const amountKes = await satsToKes(escrow.amount_sats);
    const feeKes = await satsToKes(escrow.platform_fee_sats);

    await ctx.reply(
      `📩 *Escrow Invite*\n\n` +
      `You have been invited to join an escrow as the *${inviteeRole}*.\n\n` +
      `*Trade:* ${safeDesc}\n` +
      `*Amount:* ${escrow.amount_sats.toLocaleString()} sats (~KES ${amountKes.toLocaleString()})\n` +
      `*Platform Fee:* ${escrow.platform_fee_sats.toLocaleString()} sats (~KES ${feeKes.toLocaleString()})\n` +
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
    if (err instanceof NotFoundError) {
      return ctx.reply('❌ Escrow not found. The link may be invalid or expired.');
    }
    console.error('[handleEscrowInvite]', err);
    return ctx.reply('❌ Something went wrong. Please try again later.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main menu action handlers
// ─────────────────────────────────────────────────────────────────────────────

bot.action('menu:help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    '📖 *How Lightning Escrow Works*\n\n' +
    '1️⃣ The *Buyer* creates an escrow and shares the invite link with the Seller.\n' +
    '2️⃣ The *Seller* accepts the invite.\n' +
    '3️⃣ The *Buyer* pays the Lightning invoice to fund the escrow.\n' +
    '4️⃣ Once funded, the Seller delivers the goods/service.\n' +
    '5️⃣ The *Buyer* confirms receipt → funds are released to the Seller.\n' +
    '6️⃣ If there\'s a dispute, our admin team reviews and adjudicates.\n\n' +
    `*Fee:* ${config.PLATFORM_FEE_PERCENTAGE * 100}% (min ${config.PLATFORM_FEE_MIN_SATS} sats)`,
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
          Markup.button.callback('🛒 Buyer  (I am paying)',     'escrow:role:Buyer'),
          Markup.button.callback('📦 Seller (I am receiving)',  'escrow:role:Seller'),
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
    `✅ Role set: *${role}*\n\nHow much is this trade for in KES?\n_(Just send the number, e.g. \`5000\`)_`,
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
    if (!escrows?.length) {
      return ctx.reply("You don't have any escrows yet. Create one with /start!");
    }

    const lines = await Promise.all(escrows.map(async (e) => {
      const kes = await satsToKes(e.amount_sats);
      return `• \`${e.escrow_id.slice(0, 8)}…\` | ${e.state} | ${e.amount_sats.toLocaleString()} sats (~KES ${kes.toLocaleString()})`;
    }));

    await ctx.reply(
      `📋 *Your Recent Escrows*\n\n${lines.join('\n')}`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('[menu:my_escrows]', err);
    await ctx.reply('❌ Failed to load escrows.');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Invite accept / decline
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^invite:accept:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Processing…');
  const escrowId = ctx.match[1];

  try {
    await setEscrowInvitee(escrowId, ctx.from.id);
    const escrow = await transitionEscrowState(escrowId, 'CREATED', 'PENDING_FUNDING');

    const buyerTelegramId = escrow.creator_role === 'Buyer' ? escrow.creator_id : escrow.invitee_id;
    const totalSats = escrow.amount_sats + escrow.platform_fee_sats;

    const { paymentHash, paymentRequest } = await createLightningInvoice({
      amountSats: totalSats,
      memo: `Escrow ${escrowId.slice(0, 8)} — ${escrow.trade_description}`,
    });

    await transitionEscrowState(escrowId, 'PENDING_FUNDING', 'PENDING_FUNDING', {
      blink_payment_hash: paymentHash,
    });

    const qrBuffer = await QRCode.toBuffer(paymentRequest.toUpperCase(), {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 512,
    });

    const safeDesc = escapeMd(escrow.trade_description);
    const amountKes = await satsToKes(escrow.amount_sats);
    const feeKes = await satsToKes(escrow.platform_fee_sats);
    const totalKes = await satsToKes(totalSats);

    const invoiceMessage =
      `⚡ *Escrow Funded — Invoice Ready*\n\n` +
      `*Trade:* ${safeDesc}\n` +
      `*Amount:* ${escrow.amount_sats.toLocaleString()} sats (~KES ${amountKes.toLocaleString()})\n` +
      `*Fee:* ${escrow.platform_fee_sats.toLocaleString()} sats (~KES ${feeKes.toLocaleString()})\n` +
      `*Total to Pay:* ${totalSats.toLocaleString()} sats (~KES ${totalKes.toLocaleString()})\n\n` +
      `Scan the QR code or copy the invoice below:\n\n` +
      `\`${paymentRequest}\``;

    await bot.telegram.sendPhoto(
      buyerTelegramId,
      { source: qrBuffer },
      {
        caption:    invoiceMessage,
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Check Payment Status', `check:${escrowId}`)],
        ]),
      }
    );

    await ctx.editMessageText(
      `✅ *You've joined the escrow as ${escrow.creator_role === 'Buyer' ? 'Seller' : 'Buyer'}.*\n\n` +
      `The buyer has been sent the payment invoice.\n` +
      `You'll be notified once the escrow is funded.`,
      { parse_mode: 'Markdown' }
    );

    const notifyId = buyerTelegramId === String(escrow.creator_id)
      ? escrow.invitee_id 
      : escrow.creator_id; 

    if (notifyId && notifyId !== buyerTelegramId) {
      await bot.telegram.sendMessage(
        notifyId,
        `🤝 Your counterparty has accepted the escrow!\n` +
        `Waiting for the buyer to pay the invoice (${totalSats.toLocaleString()} sats).`
      );
    }

  } catch (err) {
    if (err instanceof StateConflictError) {
      return ctx.editMessageText('⚠️ This escrow is no longer available.');
    }
    console.error('[invite:accept]', err);
    await ctx.editMessageText('❌ Failed to set up escrow. Please contact support.');
  }
});

bot.action(/^invite:decline:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('❌ You declined the escrow invite.');
});

// ─────────────────────────────────────────────────────────────────────────────
// Check payment status
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^check:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Checking…');
  const escrowId = ctx.match[1];

  try {
    const escrow = await getEscrowById(escrowId);

    if (escrow.state !== 'PENDING_FUNDING') {
      return ctx.reply(`ℹ️ Escrow is currently: *${escrow.state}*`, { parse_mode: 'Markdown' });
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
      Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Check Again', `check:${escrowId}`)],
      ])
    );
  } catch (err) {
    console.error('[check payment]', err);
    await ctx.reply('❌ Failed to check payment status.');
  }
});

async function notifyEscrowFunded(escrow) {
  const sellerTelegramId = escrow.creator_role === 'Seller' ? escrow.creator_id : escrow.invitee_id;
  const buyerTelegramId = escrow.creator_role === 'Buyer' ? escrow.creator_id : escrow.invitee_id;

  const amountKes = await satsToKes(escrow.amount_sats);
  const safeDesc = escapeMd(escrow.trade_description);

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Release Funds', `release:${escrow.escrow_id}`)],
    [Markup.button.callback('⚠️ Open Dispute', `dispute:${escrow.escrow_id}`)],
  ]);

  await bot.telegram.sendMessage(
    buyerTelegramId,
    `✅ *Escrow Funded!*\n\n` +
    `Trade: ${safeDesc}\n` +
    `Amount: ${escrow.amount_sats.toLocaleString()} sats (~KES ${amountKes.toLocaleString()})\n\n` +
    `Once you receive the goods/service, press *Release Funds*.\n` +
    `If there's an issue, press *Open Dispute*.`,
    { parse_mode: 'Markdown', ...keyboard }
  );

  await bot.telegram.sendMessage(
    sellerTelegramId,
    `✅ *Escrow is Funded!*\n\n` +
    `Trade: ${safeDesc}\n` +
    `Amount: ${escrow.amount_sats.toLocaleString()} sats (~KES ${amountKes.toLocaleString()})\n\n` +
    `Please fulfil your end of the trade. The buyer will release funds when satisfied.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Release funds (Buyer confirms delivery)
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^release:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Processing payout…');
  const escrowId = ctx.match[1];

  try {
    const escrow = await getEscrowById(escrowId);

    const buyerTelegramId = escrow.creator_role === 'Buyer' ? escrow.creator_id : escrow.invitee_id;
    if (String(ctx.from.id) !== String(buyerTelegramId)) {
      return ctx.answerCbQuery('Only the buyer can release funds.', { show_alert: true });
    }

    if (escrow.state !== 'FUNDED') {
      return ctx.answerCbQuery(`Escrow is in state ${escrow.state}.`, { show_alert: true });
    }

    await transitionEscrowState(escrowId, 'FUNDED', 'SETTLED');

    const sellerTelegramId = escrow.creator_role === 'Seller' ? escrow.creator_id : escrow.invitee_id;
    const seller = await getUserByTelegramId(sellerTelegramId);
    const memo = `Escrow settlement: ${escrow.trade_description}`;
    const amountKes = await satsToKes(escrow.amount_sats);
    const safeDesc = escapeMd(escrow.trade_description);

    if (seller.default_ln_address) {
      try {
        await payToLightningAddress({
          lnAddress:  seller.default_ln_address,
          amountSats: escrow.amount_sats,
          memo,
        });
        await incrementCompletedTrades(String(escrow.creator_id));
        await incrementCompletedTrades(String(escrow.invitee_id));
        
        const safeLn = escapeMd(seller.default_ln_address);
        await ctx.editMessageText(
          `✅ *Funds Released!*\n\n${escrow.amount_sats.toLocaleString()} sats (~KES ${amountKes.toLocaleString()}) sent to ${safeLn}`,
          { parse_mode: 'Markdown' }
        );
        await bot.telegram.sendMessage(
          sellerTelegramId,
          `🎉 *Payment received!*\n\n${escrow.amount_sats.toLocaleString()} sats (~KES ${amountKes.toLocaleString()}) have been sent to your Lightning Address.\n_Trade: ${safeDesc}_`,
          { parse_mode: 'Markdown' }
        );
        return;
      } catch (payErr) {
        if (payErr instanceof LnAddressPayoutError) {
          console.warn('[release] LN Address payout failed, falling back to BOLT11:', payErr.message);
        } else {
          throw payErr;
        }
      }
    }

    setState(sellerTelegramId, 'AWAITING_BOLT11', { escrowId, amountSats: escrow.amount_sats });
    await bot.telegram.sendMessage(
      sellerTelegramId,
      `💸 *Payout Ready!*\n\n` +
      `${escrow.amount_sats.toLocaleString()} sats (~KES ${amountKes.toLocaleString()}) are waiting for you.\n\n` +
      `⚠️ Your Lightning Address payout failed. Please send a BOLT11 invoice for *${escrow.amount_sats.toLocaleString()} sats* to receive your funds.\n\n` +
      `_(Generate one in your wallet app and paste it here.)_`,
      { parse_mode: 'Markdown' }
    );
    await ctx.editMessageText('✅ Funds released. The seller has been notified to provide an invoice.');

  } catch (err) {
    if (err instanceof StateConflictError) {
      return ctx.editMessageText('⚠️ This action was already completed.');
    }
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
      return ctx.answerCbQuery('Dispute can only be opened on a funded escrow.', { show_alert: true });
    }

    await transitionEscrowState(escrowId, 'FUNDED', 'DISPUTED');
    await incrementDisputedTrades(String(escrow.creator_id));
    if (escrow.invitee_id) {
      await incrementDisputedTrades(String(escrow.invitee_id));
    }

    await ctx.editMessageText(
      '⚠️ *Dispute Opened*\n\nOur admin team has been notified and will review your case.\nPlease do not take any further action.',
      { parse_mode: 'Markdown' }
    );

    await sendDisputeDossier(escrow, ctx.from);

  } catch (err) {
    if (err instanceof StateConflictError) {
      return ctx.editMessageText('⚠️ Escrow state changed — dispute may already be open.');
    }
    console.error('[dispute]', err);
    await ctx.editMessageText('❌ Failed to open dispute. Please contact support directly.');
  }
});

async function sendDisputeDossier(escrow, initiator) {
  const creatorHandle  = escapeMd(escrow.creator?.username  ? `@${escrow.creator.username}`  : escrow.creator_id);
  const inviteeHandle  = escapeMd(escrow.invitee?.username  ? `@${escrow.invitee.username}`  : (escrow.invitee_id ?? 'N/A'));
  const initiatorHandle = escapeMd(initiator.username ? `@${initiator.username}` : `User ${initiator.id}`);

  const safeDesc = escapeMd(escrow.trade_description);
  const amountKes = await satsToKes(escrow.amount_sats);
  const feeKes = await satsToKes(escrow.platform_fee_sats);

  const dossier =
    `🚨 *DISPUTE DOSSIER* 🚨\n\n` +
    `*Escrow ID:* \`${escrow.escrow_id}\`\n` +
    `*Trade:* ${safeDesc}\n` +
    `*Amount:* ${escrow.amount_sats.toLocaleString()} sats (~KES ${amountKes.toLocaleString()})\n` +
    `*Fee:* ${escrow.platform_fee_sats.toLocaleString()} sats (~KES ${feeKes.toLocaleString()})\n\n` +
    `*Creator (${escrow.creator_role}):* ${creatorHandle}\n` +
    `*Counterparty (${escrow.creator_role === 'Buyer' ? 'Seller' : 'Buyer'}):* ${inviteeHandle}\n\n` +
    `*Dispute opened by:* ${initiatorHandle}\n` +
    `*Payment Hash:* \`${escrow.blink_payment_hash ?? 'N/A'}\`\n\n` +
    `Please investigate and use the buttons below to resolve.`;

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
// Admin actions (DISPUTED → SETTLED / CANCELLED)
// ─────────────────────────────────────────────────────────────────────────────

function isAdmin(ctx) {
  return String(ctx.from.id) === config.ADMIN_TELEGRAM_ID;
}

bot.action(/^admin:payout:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('🚫 Unauthorised.', { show_alert: true });
  await ctx.answerCbQuery('Processing payout to seller…');
  const escrowId = ctx.match[1];

  try {
    const escrow   = await getEscrowById(escrowId);
    await transitionEscrowState(escrowId, 'DISPUTED', 'SETTLED');

    const sellerTelegramId = escrow.creator_role === 'Seller' ? escrow.creator_id : escrow.invitee_id;
    const seller = await getUserByTelegramId(sellerTelegramId);
    const memo   = `Admin-resolved escrow: ${escrow.trade_description}`;
    const amountKes = await satsToKes(escrow.amount_sats);

    if (seller.default_ln_address) {
      await payToLightningAddress({
        lnAddress:  seller.default_ln_address,
        amountSats: escrow.amount_sats,
        memo,
      });
    } else {
      setState(sellerTelegramId, 'AWAITING_BOLT11', {
        escrowId,
        amountSats: escrow.amount_sats,
      });
      await bot.telegram.sendMessage(
        sellerTelegramId,
        `💸 The admin has resolved the dispute in your favour!\n` +
        `Please send a BOLT11 invoice for *${escrow.amount_sats.toLocaleString()} sats* (~KES ${amountKes.toLocaleString()}) to receive your payout.`,
        { parse_mode: 'Markdown' }
      );
    }

    await incrementCompletedTrades(String(escrow.creator_id));
    await ctx.editMessageText(`✅ Admin Resolved: Funds paid out to Seller.\nEscrow: \`${escrowId}\``, {
      parse_mode: 'Markdown',
    });

    const buyerTelegramId = escrow.creator_role === 'Buyer' ? escrow.creator_id : escrow.invitee_id;
    await bot.telegram.sendMessage(buyerTelegramId,
      `⚖️ The admin has resolved the dispute. Funds have been released to the Seller.`);
    await bot.telegram.sendMessage(sellerTelegramId,
      `⚖️ The admin has resolved the dispute in your favour. Payout is on its way!`);

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

    const buyerTelegramId = escrow.creator_role === 'Buyer' ? escrow.creator_id : escrow.invitee_id;
    const buyer = await getUserByTelegramId(buyerTelegramId);
    const memo  = `Admin-ordered refund: ${escrow.trade_description}`;

    const refundSats = escrow.amount_sats + escrow.platform_fee_sats;
    const refundKes = await satsToKes(refundSats);

    if (buyer.default_ln_address) {
      await payToLightningAddress({
        lnAddress:  buyer.default_ln_address,
        amountSats: refundSats,
        memo,
      });
    } else {
      setState(buyerTelegramId, 'AWAITING_BOLT11', { escrowId, amountSats: refundSats });
      await bot.telegram.sendMessage(
        buyerTelegramId,
        `↩️ The admin has ordered a refund in your favour!\n` +
        `Please send a BOLT11 invoice for *${refundSats.toLocaleString()} sats* (~KES ${refundKes.toLocaleString()}).`,
        { parse_mode: 'Markdown' }
      );
    }

    await ctx.editMessageText(`✅ Admin Resolved: Refund issued to Buyer.\nEscrow: \`${escrowId}\``, {
      parse_mode: 'Markdown',
    });

    const sellerTelegramId = escrow.creator_role === 'Seller' ? escrow.creator_id : escrow.invitee_id;
    await bot.telegram.sendMessage(buyerTelegramId,
      `⚖️ The admin has resolved the dispute in your favour. A refund is on its way.`);
    if (sellerTelegramId) {
      await bot.telegram.sendMessage(sellerTelegramId,
        `⚖️ The admin has reviewed the dispute and ordered a refund to the Buyer.`);
    }

  } catch (err) {
    console.error('[admin:refund]', err);
    await ctx.editMessageText('❌ Refund failed: ' + err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Text message handler
// ─────────────────────────────────────────────────────────────────────────────

bot.on('text', async (ctx) => {
  const state = getState(ctx.from.id);
  const text  = ctx.message.text.trim();

  if (text.startsWith('/')) return;

  if (!state) {
    return sendMainMenu(ctx);
  }

  if (state.step === 'AWAITING_LN_ADDRESS') {
    if (!text.includes('@') || text.includes(' ')) {
      return ctx.reply('❌ Invalid format. Please send a Lightning Address like `alice@blink.sv`', {
        parse_mode: 'Markdown',
      });
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

  if (state.step === 'ESCROW_AWAITING_AMOUNT') {
    const kesValue = parseInt(text.replace(/[^0-9]/g, ''), 10);

    if (isNaN(kesValue) || kesValue <= 0) {
      return ctx.reply('❌ Please enter a valid KES amount (e.g. `5000`).');
    }

    try {
      const amountSats = await kesToSats(kesValue);

      if (isNaN(amountSats) || amountSats < 1000) {
        return ctx.reply('❌ Amount too low. The minimum escrow size is roughly KES 100 (1,000 sats).');
      }

      const feeSats = calculatePlatformFee(amountSats);
      const feeKes = await satsToKes(feeSats);
      
      setState(ctx.from.id, 'ESCROW_AWAITING_DESCRIPTION', {
        amountSats:      amountSats,
        platformFeeSats: feeSats,
      });

      const totalKes = kesValue + feeKes;

      await ctx.reply(
        `💰 Amount: *KES ${kesValue.toLocaleString()}* (~${amountSats.toLocaleString()} sats)\n` +
        `🏦 Platform fee: *KES ${feeKes.toLocaleString()}* (~${feeSats.toLocaleString()} sats)\n` +
        `💳 Total buyer pays: *KES ${totalKes.toLocaleString()}* (~${(amountSats + feeSats).toLocaleString()} sats)\n\n` +
        `Now, please describe the trade (e.g. "1 month VPN subscription"):`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('[kes conversion]', err);
      return ctx.reply('❌ Failed to fetch current exchange rate. Please try again.');
    }
    return;
  }

  if (state.step === 'ESCROW_AWAITING_DESCRIPTION') {
    if (text.length < 5 || text.length > 200) {
      return ctx.reply('❌ Description must be between 5 and 200 characters.');
    }

    try {
      const user   = await getUserByTelegramId(ctx.from.id);
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
      const safeDesc = escapeMd(escrow.trade_description);
      const amountKes = await satsToKes(escrow.amount_sats);

      await ctx.reply(
        `✅ *Escrow Created!*\n\n` +
        `*ID:* \`${escrow.escrow_id.slice(0, 8)}…\`\n` +
        `*Role:* ${escrow.creator_role}\n` +
        `*Amount:* ${escrow.amount_sats.toLocaleString()} sats (~KES ${amountKes.toLocaleString()})\n` +
        `*Trade:* ${safeDesc}\n\n` +
        `📤 *Share this link with your counterparty:*\n${escapeMd(inviteLink)}`,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );
    } catch (err) {
      console.error('[create escrow]', err);
      clearState(ctx.from.id);
      await ctx.reply('❌ Failed to create escrow. Please try again.');
    }
    return;
  }

  if (state.step === 'AWAITING_BOLT11') {
    if (!text.toLowerCase().startsWith('ln') || text.includes(' ')) {
      return ctx.reply('❌ That doesn\'t look like a valid BOLT11 invoice. Please try again.');
    }

    const { escrowId, amountSats } = state.data;

    try {
      await payBolt11Invoice({
        paymentRequest: text,
        memo:           `Escrow payout: ${escrowId}`,
      });
      clearState(ctx.from.id);
      const amountKes = await satsToKes(amountSats);
      await ctx.reply(`✅ *Payment sent!* ${amountSats.toLocaleString()} sats (~KES ${amountKes.toLocaleString()}) are on their way.`, {
        parse_mode: 'Markdown',
      });
    } catch (err) {
      console.error('[bolt11 payout]', err);
      await ctx.reply(
        `❌ Payment failed: ${err.message}\n\nPlease send a new BOLT11 invoice.`
      );
    }
    return;
  }

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
// Express server + webhook integration
// ─────────────────────────────────────────────────────────────────────────────

const app = express();

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use(bot.webhookCallback(WEBHOOK_PATH, {
  secretToken: config.TELEGRAM_WEBHOOK_SECRET,
}));

// ─────────────────────────────────────────────────────────────────────────────
// Startup sequence
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[startup] Validating environment…');
  console.log('[startup] Warming Blink wallet cache…');
  await initBlink();

  console.log('[startup] Registering Telegram webhook…');
  const webhookUrl = `${config.WEBHOOK_DOMAIN}${WEBHOOK_PATH}`;
  await bot.telegram.setWebhook(webhookUrl, {
    secret_token: config.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  console.log(`[startup] Webhook registered: ${webhookUrl}`);

  app.listen(config.PORT, () => {
    console.log(`[startup] Express server listening on port ${config.PORT}`);
    console.log('[startup] Bot is ready. ⚡');
  });
}

main().catch((err) => {
  console.error('[startup] FATAL:', err.message);
  process.exit(1);
});