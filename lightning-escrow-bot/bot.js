/**
 * bot.js — THE ULTIMATE MASTER V4
 *
 * CHANGE LOG (v4)
 * ───────────────
 * 8. BUYER PAYS 100% FEE — Seller receives exact trade amount. All UI 
 * text updated to remove "split 50/50". 
 * 9. REFUND MATH UPDATED — Buyer is refunded their base trade amount; 
 * the platform retains the 100% fee the buyer paid upfront.
 */

'use strict';

// ─── Fail-fast env validation ────────────────────────────────────────────────
const { config, calculatePlatformFee, splitPlatformFee } = require('./config/env');

// ─── Core dependencies ───────────────────────────────────────────────────────
const express              = require('express');
const { Telegraf, Markup } = require('telegraf');
const QRCode               = require('qrcode');

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
  updateEscrowAmount,
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
// Constants & State
// ─────────────────────────────────────────────────────────────────────────────

const WEBHOOK_PATH     = `/telegram/${config.TELEGRAM_BOT_TOKEN.replace(':', '_')}`;
const DEEP_LINK_PREFIX = 'escrow_';
const conversationState = new Map();

function escapeMd(text) {
  if (!text) return '';
  return String(text).replace(/([_*`\[])/g, '\\$1');
}

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

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN, {
  telegram: { webhookReply: true },
});

// ─────────────────────────────────────────────────────────────────────────────
// Global Middleware & Commands
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (ctx.from) {
    try { await upsertUser(ctx.from.id, ctx.from.username); } 
    catch (err) { console.error('[middleware] upsertUser failed:', err.message); }
  }
  return next();
});

bot.command('setaddress', async (ctx) => {
  setState(ctx.from.id, 'AWAITING_LN_ADDRESS');
  await ctx.reply(
    '📬 *Update Lightning Address*\n\n' +
    'Please send your new Lightning Address (e.g. `username@blink.sv`).\n' +
    'All future payouts and recovered funds will be sent here automatically.',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancel', 'menu:main')]]) }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared UI — Main Menu & Infinite Loop
// ─────────────────────────────────────────────────────────────────────────────

async function sendMainMenu(ctx, edit = false) {
  const text   = '⚡ *Lightning Escrow*\n\nSecure, trustless trades. What would you like to do?';
  const markup = Markup.inlineKeyboard([
    [Markup.button.callback('🆕 Start a Trade',          'menu:new_escrow')],
    [Markup.button.callback('📋 My Escrows',             'menu:my_escrows')],
    [Markup.button.callback('📬 Set Lightning Address',  'menu:set_ln_address')],
    [Markup.button.callback('ℹ️ How it Works',           'menu:help')],
  ]);

  if (edit) {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...markup }).catch(() => ctx.reply(text, { parse_mode: 'Markdown', ...markup }));
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', ...markup });
  }
}

bot.action('menu:main', async (ctx) => {
  await ctx.answerCbQuery();
  clearState(ctx.from.id);
  return sendMainMenu(ctx, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Entry Point & Deep Links
// ─────────────────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const payload = ctx.startPayload;
  if (payload && payload.startsWith(DEEP_LINK_PREFIX)) {
    return handleEscrowInvite(ctx, payload.slice(DEEP_LINK_PREFIX.length));
  }
  clearState(ctx.from.id);
  const safeName = escapeMd(ctx.from.first_name);
  await ctx.reply(`👋 Hey${safeName ? `, ${safeName}` : ''}! Welcome to Lightning Escrow.`, { parse_mode: 'Markdown' });
  return sendMainMenu(ctx, false);
});

async function handleEscrowInvite(ctx, escrowId) {
  try {
    const escrow = await getEscrowById(escrowId);
    if (escrow.state !== 'CREATED')                 return ctx.reply('⚠️ This escrow is no longer accepting a counterparty.');
    if (escrow.creator_id === String(ctx.from.id))  return ctx.reply("🚫 You can't join your own escrow.");
    if (escrow.invitee_id)                          return ctx.reply('⚠️ This escrow already has a counterparty.');

    const inviteeRole   = escrow.creator_role === 'Buyer' ? 'Seller' : 'Buyer';
    const creatorHandle = escapeMd(escrow.creator?.username ? `@${escrow.creator.username}` : `User ${escrow.creator_id}`);
    const safeDesc      = escapeMd(escrow.trade_description);
    const { buyerFeeSats, sellerFeeSats } = splitPlatformFee(escrow.platform_fee_sats);
    const inviteeFeeSats = inviteeRole === 'Buyer' ? buyerFeeSats : sellerFeeSats;
    const amountKes      = await satsToKes(escrow.amount_sats);
    const inviteFeeKes   = await satsToKes(inviteeFeeSats);

    const feeLabel = inviteeRole === 'Buyer'
      ? `*Escrow Fee:* ${buyerFeeSats.toLocaleString()} sats (~KES ${inviteFeeKes.toLocaleString()}) _added to your payment_`
      : `*Escrow Fee:* 0 sats _(Paid by Buyer)_`;
    const netLabel = inviteeRole === 'Buyer'
      ? `*You will pay:* ${(escrow.amount_sats + buyerFeeSats).toLocaleString()} sats total`
      : `*You will receive:* ${(escrow.amount_sats - sellerFeeSats).toLocaleString()} sats net`;

    await ctx.reply(
      `📩 *Trade Invite*\n\n` +
      `You have been invited to join as the *${inviteeRole}*.\n\n` +
      `*Trade:* ${safeDesc}\n` +
      `*Amount:* ${escrow.amount_sats.toLocaleString()} sats (~KES ${amountKes.toLocaleString()})\n` +
      `${feeLabel}\n` +
      `${netLabel}\n\n` +
      `*From:* ${creatorHandle}\n\n` +
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
// Main Menu Handlers
// ─────────────────────────────────────────────────────────────────────────────

bot.action('menu:help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '📖 *How Lightning Escrow Works*\n\n' +
    'Trading safely online has never been easier. Here is how we protect your money:\n\n' +
    '1️⃣ *Start a Trade:* The Buyer creates a trade and shares the link.\n' +
    '2️⃣ *Accept & Connect:* The Seller accepts the invite.\n' +
    '3️⃣ *Lock the Funds:* The Buyer pays the invoice to lock the funds in escrow.\n' +
    '4️⃣ *Delivery:* The Seller delivers the goods or services as promised.\n' +
    '5️⃣ *Get Paid:* The Buyer confirms receipt, and funds are instantly released to the Seller!\n' +
    '6️⃣ *Support:* If anything goes wrong, open a dispute and our admin team will step in.\n\n' +
    `*💸 Platform Fee:* Just *${config.PLATFORM_FEE_PERCENTAGE * 100}%* of the trade amount.\n\n` +
    '---\n' +
    '⚡️ *New to Bitcoin Lightning? Your Starter Pack:*\n\n' +
    '• *Get a Wallet:* Download [Blink](https://www.blink.sv/) or [Wallet of Satoshi](https://www.walletofsatoshi.com/) to get a free Lightning Address.\n' +
    '• *Buy Sats:* Use [Bitika](https://bitika.xyz/) to buy sats instantly via M-Pesa.\n' +
    '• *Spend & Cash Out:* Use [Tando](https://tando.me/) to spend your sats directly to any M-Pesa number or till.',
    {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🆕 Start a Trade', 'menu:new_escrow')], 
        [Markup.button.callback('🔙 Back to Menu',  'menu:main')]
      ]),
    }
  );
});

bot.action('menu:set_ln_address', async (ctx) => {
  await ctx.answerCbQuery();
  setState(ctx.from.id, 'AWAITING_LN_ADDRESS');
  await ctx.editMessageText(
    '📬 *Payout Address*\n\nWhat is your Lightning Address? Just type it below.\n\n_Example: alice@blink.sv_',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancel', 'menu:main')]]) }
  );
});

bot.action('menu:new_escrow', async (ctx) => {
  await ctx.answerCbQuery();
  setState(ctx.from.id, 'ESCROW_AWAITING_ROLE');
  await ctx.editMessageText(
    '🆕 *New Trade*\n\nAre you buying or selling in this transaction?',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🛒 I am Buying',  'escrow:role:Buyer'), Markup.button.callback('📦 I am Selling', 'escrow:role:Seller')],
        [Markup.button.callback('🔙 Cancel', 'menu:main')],
      ]),
    }
  );
});

bot.action(/^escrow:role:(Buyer|Seller)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const role = ctx.match[1];
  setState(ctx.from.id, 'ESCROW_AWAITING_AMOUNT', { role });
  await ctx.editMessageText(
    `You are the *${role}*.\n\nHow much is this trade worth in KES? Just type the number.`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancel', 'menu:main')]]) }
  );
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
      return ctx.editMessageText(
        "You don't have any escrows yet. Ready to start your first trade?",
        { ...Markup.inlineKeyboard([[Markup.button.callback('🆕 Start a Trade', 'menu:new_escrow')], [Markup.button.callback('🔙 Back to Menu', 'menu:main')]]) }
      );
    }
    
    const lines = await Promise.all(escrows.map(async (e) => {
      const kes = await satsToKes(e.amount_sats);
      return `• \`${e.escrow_id.slice(0, 8)}…\` | ${e.state} | ${e.amount_sats.toLocaleString()} sats (~KES ${kes.toLocaleString()})`;
    }));
    
    await ctx.editMessageText(
      `📋 *Your Recent Escrows*\n\n${lines.join('\n')}`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🆕 Start a Trade', 'menu:new_escrow')], [Markup.button.callback('🔙 Back to Menu', 'menu:main')]]) }
    );
  } catch (err) {
    console.error('[menu:my_escrows]', err);
    await ctx.editMessageText('❌ Could not load your escrows right now.', { ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Menu', 'menu:main')]]) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Invite & Escrow Modification Handlers
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^edit_amount:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const escrowId = ctx.match[1];
  try {
    const escrow = await getEscrowById(escrowId);
    if (escrow.creator_id !== String(ctx.from.id)) return ctx.reply('🚫 Only the creator can edit the amount.', { show_alert: true });
    if (escrow.state !== 'CREATED') return ctx.reply('⚠️ The amount cannot be edited after the counterparty has accepted. You must cancel and create a new escrow.');
    
    setState(ctx.from.id, 'AWAITING_NEW_AMOUNT', { escrowId });
    await ctx.reply(
      '✏️ *Edit Trade Amount*\n\nPlease send the new trade amount in KES (e.g. `6000`):', 
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancel', 'menu:main')]]) }
    );
  } catch (err) {
    console.error('[edit amount action]', err);
    await ctx.reply('❌ Failed to fetch escrow.');
  }
});

bot.action(/^invite:accept:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Processing…');
  const escrowId = ctx.match[1];
  try {
    const escrow = await getEscrowById(escrowId);
    if (escrow.state !== 'CREATED')                return ctx.editMessageText('⚠️ This escrow is no longer available.');
    if (escrow.creator_id === String(ctx.from.id)) return ctx.editMessageText("🚫 You can't join your own escrow.");
    if (escrow.invitee_id)                         return ctx.editMessageText('⚠️ This escrow already has a counterparty.');

    const acceptingRole = escrow.creator_role === 'Buyer' ? 'Seller' : 'Buyer';
    const user          = await getUserByTelegramId(ctx.from.id);

    if (acceptingRole === 'Seller' && !user.default_ln_address) {
      setState(ctx.from.id, 'AWAITING_UPFRONT_LN_ADDRESS', { escrowId });
      return ctx.editMessageText(
        '📬 *One last thing before you accept.*\n\n' +
        'Please type your Lightning Address below.\n' +
        'This is where your funds will be sent automatically when the buyer releases them.\n\n' +
        '_Example: alice@blink.sv_',
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancel', 'menu:main')]]) }
      );
    }

    if (acceptingRole === 'Buyer' && !user.default_ln_address) {
      setState(ctx.from.id, 'AWAITING_BUYER_LN_ADDRESS', { escrowId, context: 'invite_accept' });
      return ctx.editMessageText(
        '📬 *One last thing before you accept.*\n\n' +
        'Please type your Lightning Address below.\n' +
        'This is used to automatically refund you if the trade is cancelled or disputed in your favour.\n\n' +
        '_Example: alice@blink.sv_',
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancel', 'menu:main')]]) }
      );
    }
    await completeEscrowAcceptance(ctx, escrowId);
  } catch (err) {
    if (err instanceof StateConflictError) return ctx.editMessageText('⚠️ This escrow is no longer available.');
    console.error('[invite:accept]', err);
    await ctx.editMessageText('❌ Something went wrong. Please try again or contact support.');
  }
});

bot.action(/^invite:decline:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('❌ You declined the invite.', { ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Main Menu', 'menu:main')]]) });
});

async function completeEscrowAcceptance(ctx, escrowId) {
  await setEscrowInvitee(escrowId, ctx.from.id);
  const escrow = await transitionEscrowState(escrowId, 'CREATED', 'PENDING_FUNDING');
  const { buyerFeeSats, sellerFeeSats } = splitPlatformFee(escrow.platform_fee_sats);
  const buyerTelegramId  = escrow.creator_role === 'Buyer'  ? escrow.creator_id : escrow.invitee_id;
  const sellerTelegramId = escrow.creator_role === 'Seller' ? escrow.creator_id : escrow.invitee_id;
  
  const invoiceAmountSats = escrow.amount_sats + buyerFeeSats;
  const sellerPayoutSats  = escrow.amount_sats - sellerFeeSats;

  const { paymentHash, paymentRequest } = await createLightningInvoice({
    amountSats: invoiceAmountSats,
    memo:       `Escrow ${escrowId.slice(0, 8)} — ${escrow.trade_description}`,
  });
  await transitionEscrowState(escrowId, 'PENDING_FUNDING', 'PENDING_FUNDING', { blink_payment_hash: paymentHash });

  const tradeKes      = await satsToKes(escrow.amount_sats);
  const buyerFeeKes   = await satsToKes(buyerFeeSats);
  const invoiceKes    = await satsToKes(invoiceAmountSats);
  const payoutKes     = await satsToKes(sellerPayoutSats);
  const safeDesc      = escapeMd(escrow.trade_description);

  const qrBuffer = await QRCode.toBuffer(paymentRequest.toUpperCase(), { type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 512 });
  
  await bot.telegram.sendPhoto(
    buyerTelegramId,
    { source: qrBuffer },
    {
      caption:
        `⚡ *Your Payment Invoice*\n\n` +
        `*Trade:* ${safeDesc}\n\n` +
        `*Trade amount:* ${escrow.amount_sats.toLocaleString()} sats (~KES ${tradeKes.toLocaleString()})\n` +
        `*Escrow Fee:* ${buyerFeeSats.toLocaleString()} sats (~KES ${buyerFeeKes.toLocaleString()})\n` +
        `*─────────────────────────*\n` +
        `*Total you pay:* ${invoiceAmountSats.toLocaleString()} sats (~KES ${invoiceKes.toLocaleString()})\n\n` +
        `Scan the QR or copy the invoice below, then tap *Check Payment* once paid.`,
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Check Payment', `check:${escrowId}`)]]),
    }
  );
  await bot.telegram.sendMessage(buyerTelegramId, `\`${paymentRequest}\``, { parse_mode: 'Markdown' });

  await bot.telegram.sendMessage(
    sellerTelegramId,
    `✅ *You have accepted the trade!*\n\n` +
    `*Trade:* ${safeDesc}\n` +
    `*Trade amount:* ${escrow.amount_sats.toLocaleString()} sats (~KES ${tradeKes.toLocaleString()})\n` +
    `*Escrow Fee:* 0 sats (Paid by Buyer)\n` +
    `*─────────────────────────*\n` +
    `*You will receive:* ${sellerPayoutSats.toLocaleString()} sats (~KES ${payoutKes.toLocaleString()})\n\n` +
    `Waiting for the buyer to fund the escrow. You'll be notified the moment it's confirmed.`,
    { parse_mode: 'Markdown' }
  );

  try {
    await ctx.editMessageText('✅ *Escrow accepted!* Both parties have been notified.', { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply('✅ *Escrow accepted!* Both parties have been notified.', { parse_mode: 'Markdown' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Trade Lifecycle Actions (Check, Shipped, Release, Dispute)
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^check:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Checking…');
  const escrowId = ctx.match[1];
  try {
    const escrow = await getEscrowById(escrowId);
    if (escrow.state !== 'PENDING_FUNDING') {
      return ctx.reply(`ℹ️ This escrow is currently *${escrow.state}*.`, { parse_mode: 'Markdown' });
    }
    const { status } = await getInvoiceStatus(escrow.blink_payment_hash);
    if (status === 'PAID') {
      await transitionEscrowState(escrowId, 'PENDING_FUNDING', 'FUNDED');
      await notifyEscrowFunded(escrow);
      return ctx.reply('✅ *Payment confirmed! The escrow is now funded.*', { parse_mode: 'Markdown' });
    }
    if (status === 'EXPIRED') {
      await transitionEscrowState(escrowId, 'PENDING_FUNDING', 'CANCELLED');
      return ctx.reply('⏰ The invoice has expired and the escrow has been cancelled.');
    }
    await ctx.reply(
      "⏳ Payment hasn't arrived yet. Pay the invoice and tap Check again when you're done.",
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Check Again', `check:${escrowId}`)]])
    );
  } catch (err) {
    console.error('[check payment]', err);
    await ctx.reply('❌ Could not check payment status. Please try again.');
  }
});

async function notifyEscrowFunded(escrow) {
  const sellerTelegramId = escrow.creator_role === 'Seller' ? escrow.creator_id : escrow.invitee_id;
  const buyerTelegramId  = escrow.creator_role === 'Buyer'  ? escrow.creator_id : escrow.invitee_id;
  const { sellerFeeSats } = splitPlatformFee(escrow.platform_fee_sats);
  const sellerPayoutSats  = escrow.amount_sats - sellerFeeSats;
  const tradeKes          = await satsToKes(escrow.amount_sats);
  const payoutKes         = await satsToKes(sellerPayoutSats);
  const safeDesc          = escapeMd(escrow.trade_description);

  await bot.telegram.sendMessage(
    buyerTelegramId,
    `🔒 *Escrow Funded!*\n\n` +
    `*Trade:* ${safeDesc}\n` +
    `*Amount locked:* ${escrow.amount_sats.toLocaleString()} sats (~KES ${tradeKes.toLocaleString()})\n\n` +
    `Once you've received the goods or service, tap *Release Funds*.\n` +
    `If something is wrong, tap *Open Dispute* and the admin team will step in.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Release Funds', `release:${escrow.escrow_id}`)],
        [Markup.button.callback('⚠️ Open Dispute',  `dispute:${escrow.escrow_id}`)],
      ]),
    }
  );

  await bot.telegram.sendMessage(
    sellerTelegramId,
    `🔒 *Escrow is Funded!*\n\n` +
    `*Trade:* ${safeDesc}\n` +
    `*You will receive:* ${sellerPayoutSats.toLocaleString()} sats (~KES ${payoutKes.toLocaleString()})\n\n` +
    `Please fulfil your end of the trade, then click the button below to notify the buyer.`,
    { 
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('📦 Mark as Delivered/Shipped', `shipped:${escrow.escrow_id}`)]])
    }
  );
}

bot.action(/^shipped:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Notifying buyer…');
  const escrowId = ctx.match[1];
  try {
    const escrow = await getEscrowById(escrowId);
    const sellerTelegramId = escrow.creator_role === 'Seller' ? escrow.creator_id : escrow.invitee_id;
    const buyerTelegramId  = escrow.creator_role === 'Buyer'  ? escrow.creator_id : escrow.invitee_id;

    if (String(ctx.from.id) !== String(sellerTelegramId)) return ctx.answerCbQuery('Only the seller can mark this as shipped.', { show_alert: true });
    if (escrow.state !== 'FUNDED') return ctx.answerCbQuery(`Escrow is currently: ${escrow.state}`, { show_alert: true });

    const safeDesc = escapeMd(escrow.trade_description);
    const releaseKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('✅ Release Funds', `release:${escrow.escrow_id}`)],
      [Markup.button.callback('⚠️ Open Dispute',  `dispute:${escrow.escrow_id}`)],
    ]);

    await bot.telegram.sendMessage(
      buyerTelegramId,
      `📦 *Order Fulfilled!*\n\nThe seller has marked the following trade as delivered/shipped:\n_Trade: ${safeDesc}_\n\nPlease verify you received what you paid for. If everything looks good, release the funds.`,
      { parse_mode: 'Markdown', ...releaseKeyboard }
    );

    await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([[Markup.button.callback('✅ Marked as Shipped (Waiting for Buyer)', 'noop')]]).reply_markup);
  } catch (err) {
    console.error('[shipped action]', err);
    await ctx.answerCbQuery('❌ Failed to notify buyer.', { show_alert: true });
  }
});

bot.action('noop', async (ctx) => { await ctx.answerCbQuery(); });

bot.action(/^release:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Processing payout…');
  const escrowId = ctx.match[1];
  try {
    const escrow = await getEscrowById(escrowId);
    const buyerTelegramId  = escrow.creator_role === 'Buyer'  ? escrow.creator_id : escrow.invitee_id;
    const sellerTelegramId = escrow.creator_role === 'Seller' ? escrow.creator_id : escrow.invitee_id;

    if (String(ctx.from.id) !== String(buyerTelegramId)) return ctx.answerCbQuery('Only the buyer can release funds.', { show_alert: true });
    if (escrow.state !== 'FUNDED') return ctx.answerCbQuery(`This escrow is currently ${escrow.state}.`, { show_alert: true });

    await transitionEscrowState(escrowId, 'FUNDED', 'SETTLED');
    const { sellerFeeSats } = splitPlatformFee(escrow.platform_fee_sats);
    const sellerPayoutSats  = escrow.amount_sats - sellerFeeSats;
    const payoutKes         = await satsToKes(sellerPayoutSats);
    const safeDesc          = escapeMd(escrow.trade_description);
    const seller            = await getUserByTelegramId(sellerTelegramId);
    const memo              = `Escrow settlement: ${escrow.trade_description}`;

    if (seller.default_ln_address) {
      try {
        await payToLightningAddress({ lnAddress: seller.default_ln_address, amountSats: sellerPayoutSats, memo });
        await setPayoutSuccessful(escrowId);
        await incrementCompletedTrades(String(escrow.creator_id));
        await incrementCompletedTrades(String(escrow.invitee_id));
        const safeLn = escapeMd(seller.default_ln_address);
        
        await ctx.editMessageText(
          `✅ *Funds Released!*\n\n${sellerPayoutSats.toLocaleString()} sats (~KES ${payoutKes.toLocaleString()}) sent to ${safeLn}.\n\nTrade complete. Thank you for using Lightning Escrow!`,
          { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Main Menu', 'menu:main')]]) }
        );
        await bot.telegram.sendMessage(
          sellerTelegramId,
          `🎉 *Payment received!*\n\n${sellerPayoutSats.toLocaleString()} sats (~KES ${payoutKes.toLocaleString()}) have landed in your Lightning Address.\n_Trade: ${safeDesc}_\n\nThanks for trading with Lightning Escrow!`,
          { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🆕 Start a New Trade', 'menu:new_escrow')]]) }
        );
        return;
      } catch (payErr) {
        if (payErr instanceof LnAddressPayoutError) console.warn('[release] LN Address payout failed:', payErr.message);
        else throw payErr;
      }
    }

    setState(sellerTelegramId, 'AWAITING_BOLT11', { escrowId, amountSats: sellerPayoutSats });
    await bot.telegram.sendMessage(
      sellerTelegramId,
      `💸 *Payout Ready — Action Required*\n\nYou have *${sellerPayoutSats.toLocaleString()} sats* (~KES ${payoutKes.toLocaleString()}) waiting.\n\n⚠️ Automatic payout failed.\nPlease paste a BOLT11 invoice for *${sellerPayoutSats.toLocaleString()} sats* to claim your funds now.`,
      { parse_mode: 'Markdown' }
    );
    await ctx.editMessageText('✅ Funds released. The seller has been asked to provide a payment invoice.');
  } catch (err) {
    if (err instanceof StateConflictError) return ctx.editMessageText('⚠️ This action was already completed.');
    console.error('[release funds]', err);
    await ctx.editMessageText('❌ Payout failed. Please contact support.');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin / Dispute flow
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^dispute:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Opening dispute…');
  const escrowId = ctx.match[1];
  try {
    const escrow = await getEscrowById(escrowId);
    if (escrow.state !== 'FUNDED') return ctx.answerCbQuery('Disputes can only be opened on a funded escrow.', { show_alert: true });
    
    await transitionEscrowState(escrowId, 'FUNDED', 'DISPUTED');
    await incrementDisputedTrades(String(escrow.creator_id));
    if (escrow.invitee_id) await incrementDisputedTrades(String(escrow.invitee_id));
    
    await ctx.editMessageText('⚠️ *Dispute Opened*\n\nOur admin team has been notified and will review your case.\nPlease do not take any further action — you will hear back shortly.', { parse_mode: 'Markdown' });
    await sendDisputeDossier(escrow, ctx.from);
  } catch (err) {
    if (err instanceof StateConflictError) return ctx.editMessageText('⚠️ Escrow state changed — dispute may already be open.');
    console.error('[dispute]', err);
    await ctx.editMessageText('❌ Failed to open dispute. Please contact support directly.');
  }
});

async function sendDisputeDossier(escrow, initiator) {
  const creatorHandle   = escapeMd(escrow.creator?.username  ? `@${escrow.creator.username}`  : escrow.creator_id);
  const inviteeHandle   = escapeMd(escrow.invitee?.username  ? `@${escrow.invitee.username}`  : (escrow.invitee_id ?? 'N/A'));
  const initiatorHandle = escapeMd(initiator.username ? `@${initiator.username}` : `User ${initiator.id}`);
  const safeDesc        = escapeMd(escrow.trade_description);
  
  const { sellerFeeSats } = splitPlatformFee(escrow.platform_fee_sats);
  const sellerPayoutSats = escrow.amount_sats - sellerFeeSats;
  
  // V4 RULE: Refund buyer the base trade amount. Platform keeps the fee.
  const buyerRefundSats  = escrow.amount_sats; 
  
  const amountKes  = await satsToKes(escrow.amount_sats);
  const payoutKes  = await satsToKes(sellerPayoutSats);
  const refundKes  = await satsToKes(buyerRefundSats);

  const dossier =
    `🚨 *DISPUTE DOSSIER* 🚨\n\n` +
    `*Escrow ID:* \`${escrow.escrow_id}\`\n` +
    `*Trade:* ${safeDesc}\n` +
    `*Amount:* ${escrow.amount_sats.toLocaleString()} sats (~KES ${amountKes.toLocaleString()})\n\n` +
    `*Creator (${escrow.creator_role}):* ${creatorHandle}\n` +
    `*Counterparty (${escrow.creator_role === 'Buyer' ? 'Seller' : 'Buyer'}):* ${inviteeHandle}\n\n` +
    `*Opened by:* ${initiatorHandle}\n` +
    `*Payment Hash:* \`${escrow.blink_payment_hash ?? 'N/A'}\`\n\n` +
    `*If you pay Seller:* ${sellerPayoutSats.toLocaleString()} sats (~KES ${payoutKes.toLocaleString()})\n` +
    `*If you refund Buyer:* ${buyerRefundSats.toLocaleString()} sats (~KES ${refundKes.toLocaleString()})`;

  await bot.telegram.sendMessage(config.ADMIN_TELEGRAM_ID, dossier, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('💸 Payout Seller', `admin:payout:${escrow.escrow_id}`), Markup.button.callback('↩️ Refund Buyer',  `admin:refund:${escrow.escrow_id}`)],
    ]),
  });
}

function isAdmin(ctx) { return String(ctx.from.id) === config.ADMIN_TELEGRAM_ID; }

bot.action(/^admin:payout:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('🚫 Unauthorised.', { show_alert: true });
  await ctx.answerCbQuery('Processing payout to seller…');
  const escrowId = ctx.match[1];
  try {
    const escrow           = await getEscrowById(escrowId);
    await transitionEscrowState(escrowId, 'DISPUTED', 'SETTLED');
    const sellerTelegramId = escrow.creator_role === 'Seller' ? escrow.creator_id : escrow.invitee_id;
    const buyerTelegramId  = escrow.creator_role === 'Buyer'  ? escrow.creator_id : escrow.invitee_id;
    const seller           = await getUserByTelegramId(sellerTelegramId);
    const memo             = `Admin-resolved escrow: ${escrow.trade_description}`;
    const { sellerFeeSats } = splitPlatformFee(escrow.platform_fee_sats);
    const sellerPayoutSats  = escrow.amount_sats - sellerFeeSats;
    const payoutKes         = await satsToKes(sellerPayoutSats);

    if (seller.default_ln_address) {
      await payToLightningAddress({ lnAddress: seller.default_ln_address, amountSats: sellerPayoutSats, memo });
      await setPayoutSuccessful(escrowId);
    } else {
      setState(sellerTelegramId, 'AWAITING_BOLT11', { escrowId, amountSats: sellerPayoutSats });
      await bot.telegram.sendMessage(
        sellerTelegramId,
        `💸 The admin resolved the dispute in your favour!\n\nPlease paste a BOLT11 invoice for *${sellerPayoutSats.toLocaleString()} sats* (~KES ${payoutKes.toLocaleString()}) to receive your payout.`,
        { parse_mode: 'Markdown' }
      );
    }
    await incrementCompletedTrades(String(escrow.creator_id));
    await ctx.editMessageText(`✅ Resolved: Seller paid.\nEscrow: \`${escrowId}\``, { parse_mode: 'Markdown' });
    await bot.telegram.sendMessage(buyerTelegramId,  '⚖️ The admin has reviewed the dispute and released funds to the Seller.');
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
    const escrow          = await getEscrowById(escrowId);
    await transitionEscrowState(escrowId, 'DISPUTED', 'CANCELLED');
    const buyerTelegramId  = escrow.creator_role === 'Buyer'  ? escrow.creator_id : escrow.invitee_id;
    const sellerTelegramId = escrow.creator_role === 'Seller' ? escrow.creator_id : escrow.invitee_id;
    const buyer            = await getUserByTelegramId(buyerTelegramId);
    const memo             = `Admin-ordered refund: ${escrow.trade_description}`;
    
    // V4 RULE: Refund buyer the base trade amount. Platform keeps the fee.
    const refundSats       = escrow.amount_sats; 
    const refundKes        = await satsToKes(refundSats);

    if (buyer.default_ln_address) {
      await payToLightningAddress({ lnAddress: buyer.default_ln_address, amountSats: refundSats, memo });
      await setPayoutSuccessful(escrowId);
    } else {
      setState(buyerTelegramId, 'AWAITING_BOLT11', { escrowId, amountSats: refundSats });
      await bot.telegram.sendMessage(
        buyerTelegramId,
        `↩️ The admin ordered a refund in your favour!\n\nPlease paste a BOLT11 invoice for *${refundSats.toLocaleString()} sats* (~KES ${refundKes.toLocaleString()}) to receive your refund.`,
        { parse_mode: 'Markdown' }
      );
    }
    await ctx.editMessageText(`✅ Resolved: Buyer refunded.\nEscrow: \`${escrowId}\``, { parse_mode: 'Markdown' });
    await bot.telegram.sendMessage(buyerTelegramId,  '⚖️ The admin resolved the dispute in your favour. A refund is on its way.');
    if (sellerTelegramId) await bot.telegram.sendMessage(sellerTelegramId, '⚖️ The admin reviewed the dispute and ordered a refund to the Buyer.');
  } catch (err) {
    console.error('[admin:refund]', err);
    await ctx.editMessageText('❌ Refund failed: ' + err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Text Handlers (Form Data Input)
// ─────────────────────────────────────────────────────────────────────────────

bot.on('text', async (ctx) => {
  const state = getState(ctx.from.id);
  const text  = ctx.message.text.trim();
  if (text.startsWith('/')) return; 
  if (!state) return sendMainMenu(ctx, false);

  if (state.step === 'AWAITING_LN_ADDRESS') {
    if (!text.includes('@') || text.includes(' ')) {
      return ctx.reply("That doesn't look right. A Lightning Address looks like `alice@blink.sv` — give it another go.", { parse_mode: 'Markdown' });
    }
    try {
      await setDefaultLnAddress(ctx.from.id, text.toLowerCase());
      clearState(ctx.from.id);
      await ctx.reply(
        `✅ Address saved! Payouts and refunds will automatically land at \`${text.toLowerCase()}\`.\n\nReady to make a trade?`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🆕 Start a Trade', 'menu:new_escrow')], [Markup.button.callback('🔙 Main Menu', 'menu:main')]]) }
      );
    } catch (err) {
      console.error('[set ln address]', err);
      return ctx.reply('❌ Failed to save. Please try again.');
    }
    return;
  }

  if (state.step === 'AWAITING_UPFRONT_LN_ADDRESS') {
    if (!text.includes('@') || text.includes(' ')) return ctx.reply("That doesn't look like a valid Lightning Address. Try something like `alice@blink.sv`.", { parse_mode: 'Markdown' });
    const lnAddress = text.toLowerCase();
    const { escrowId } = state.data;
    try {
      await setDefaultLnAddress(ctx.from.id, lnAddress);
      clearState(ctx.from.id);
      await ctx.reply(`✅ Address saved: \`${lnAddress}\`\n\nProcessing your acceptance now…`, { parse_mode: 'Markdown' });
      await completeEscrowAcceptance(ctx, escrowId);
    } catch (err) {
      if (err instanceof StateConflictError) return ctx.reply('⚠️ This escrow is no longer available.');
      console.error('[AWAITING_UPFRONT_LN_ADDRESS]', err);
      clearState(ctx.from.id);
      return ctx.reply('❌ Something went wrong. Please try again or contact support.');
    }
    return;
  }

  if (state.step === 'AWAITING_BUYER_LN_ADDRESS') {
    if (!text.includes('@') || text.includes(' ')) return ctx.reply("That doesn't look like a valid Lightning Address. Try something like `alice@blink.sv`.", { parse_mode: 'Markdown' });
    const lnAddress = text.toLowerCase();
    const { escrowId, context } = state.data;
    try {
      await setDefaultLnAddress(ctx.from.id, lnAddress);
      clearState(ctx.from.id);
      if (context === 'invite_accept') {
        await ctx.reply(`✅ Address saved: \`${lnAddress}\`\n\nProcessing your acceptance now…`, { parse_mode: 'Markdown' });
        await completeEscrowAcceptance(ctx, escrowId);
      } else {
        await ctx.reply(
          `✅ Done! Your Lightning Address \`${lnAddress}\` has been saved for refunds.\n\nYour escrow is live — share the invite link with your counterparty to get started.`,
          { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('📋 My Escrows', 'menu:my_escrows')], [Markup.button.callback('🔙 Main Menu', 'menu:main')]]) }
        );
      }
    } catch (err) {
      if (err instanceof StateConflictError) return ctx.reply('⚠️ This escrow is no longer available.');
      console.error('[AWAITING_BUYER_LN_ADDRESS]', err);
      clearState(ctx.from.id);
      return ctx.reply('❌ Something went wrong. Please try again or contact support.');
    }
    return;
  }

  if (state.step === 'ESCROW_AWAITING_AMOUNT') {
    const kesValue = parseInt(text.replace(/[^0-9]/g, ''), 10);
    if (isNaN(kesValue) || kesValue <= 0) return ctx.reply("Just send the number — e.g. `5000` for KES 5,000.", { parse_mode: 'Markdown' });
    try {
      const amountSats = await kesToSats(kesValue);
      if (isNaN(amountSats) || amountSats < 1000) return ctx.reply('That amount is too small. The minimum trade is roughly KES 100 (1,000 sats).');
      const totalFeeSats = calculatePlatformFee(amountSats);
      const { buyerFeeSats, sellerFeeSats } = splitPlatformFee(totalFeeSats);
      const buyerFeeKes    = await satsToKes(buyerFeeSats);
      const buyerTotalKes  = await satsToKes(amountSats + buyerFeeSats);
      const sellerNetKes   = await satsToKes(amountSats - sellerFeeSats);

      setState(ctx.from.id, 'ESCROW_AWAITING_DESCRIPTION', { amountSats, platformFeeSats: totalFeeSats });
      await ctx.reply(
        `💰 *Trade Amount:* KES ${kesValue.toLocaleString()} (~${amountSats.toLocaleString()} sats)\n\n` +
        `*Fee Breakdown (${config.PLATFORM_FEE_PERCENTAGE * 100}%, paid by Buyer):*\n` +
        `  🛒 Buyer fee: KES ${buyerFeeKes.toLocaleString()} (~${buyerFeeSats.toLocaleString()} sats)\n` +
        `  📦 Seller fee: 0 KES (0 sats)\n\n` +
        `*Net Result:*\n` +
        `  🛒 Buyer total: KES ${buyerTotalKes.toLocaleString()}\n` +
        `  📦 Seller receives: KES ${sellerNetKes.toLocaleString()}\n\n` +
        `Perfect. What exactly are you trading? Send me a quick description.`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancel', 'menu:main')]]) }
      );
    } catch (err) {
      console.error('[kes conversion]', err);
      return ctx.reply('❌ Could not fetch the current exchange rate. Please try again.');
    }
    return;
  }

  if (state.step === 'AWAITING_NEW_AMOUNT') {
    const kesValue = parseInt(text.replace(/[^0-9]/g, ''), 10);
    if (isNaN(kesValue) || kesValue <= 0) return ctx.reply('❌ Please enter a valid KES amount (e.g. `5000`).');
    try {
      const amountSats = await kesToSats(kesValue);
      if (isNaN(amountSats) || amountSats < 1000) return ctx.reply('❌ Amount too low. The minimum escrow size is roughly KES 100 (1,000 sats).');
      
      const { escrowId } = state.data;
      const totalFeeSats = calculatePlatformFee(amountSats);
      const updatedEscrow = await updateEscrowAmount(escrowId, amountSats, totalFeeSats);
      clearState(ctx.from.id);

      const botUsername = ctx.botInfo?.username ?? 'this_bot';
      const inviteLink  = `https://t.me/${botUsername}?start=${DEEP_LINK_PREFIX}${updatedEscrow.escrow_id}`;
      const { buyerFeeSats } = splitPlatformFee(updatedEscrow.platform_fee_sats);
      const amountKes   = await satsToKes(updatedEscrow.amount_sats);
      const safeDesc    = escapeMd(updatedEscrow.trade_description);
      const safeLink    = escapeMd(inviteLink);
      
      const creatorFeeNote = updatedEscrow.creator_role === 'Buyer'
        ? `*Escrow Fee:* ${buyerFeeSats.toLocaleString()} sats added to your payment`
        : `*Escrow Fee:* 0 sats (Paid by Buyer)`;

      await ctx.reply(
        `✅ *Escrow Amount Updated!*\n\n` +
        `*ID:* \`${updatedEscrow.escrow_id.slice(0, 8)}…\`\n` +
        `*Your role:* ${updatedEscrow.creator_role}\n` +
        `*Trade amount:* ${updatedEscrow.amount_sats.toLocaleString()} sats (~KES ${amountKes.toLocaleString()})\n` +
        `*${creatorFeeNote}*\n` +
        `*Trade:* ${safeDesc}\n\n` +
        `📤 *Share this link with your counterparty:*\n${safeLink}`,
        { 
          parse_mode: 'Markdown', disable_web_page_preview: true,
          ...Markup.inlineKeyboard([[Markup.button.callback('✏️ Edit Amount', `edit_amount:${updatedEscrow.escrow_id}`)]])
        }
      );
    } catch (err) {
      console.error('[edit amount text]', err);
      clearState(ctx.from.id);
      return ctx.reply('❌ Failed to update amount. Please try again.');
    }
    return;
  }

  if (state.step === 'ESCROW_AWAITING_DESCRIPTION') {
    if (text.length < 5 || text.length > 200) return ctx.reply('Keep the description between 5 and 200 characters and try again.');
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
      const { buyerFeeSats } = splitPlatformFee(escrow.platform_fee_sats);
      const amountKes    = await satsToKes(escrow.amount_sats);
      const safeDesc     = escapeMd(escrow.trade_description);
      
      const creatorFeeNote = escrow.creator_role === 'Buyer'
        ? `*Escrow Fee:* ${buyerFeeSats.toLocaleString()} sats added to your payment`
        : `*Escrow Fee:* 0 sats (Paid by Buyer)`;

      await ctx.reply(
        `✅ *Trade Created!*\n\n` +
        `*ID:* \`${escrow.escrow_id.slice(0, 8)}…\`\n` +
        `*Your role:* ${escrow.creator_role}\n` +
        `*Amount:* ${escrow.amount_sats.toLocaleString()} sats (~KES ${amountKes.toLocaleString()})\n` +
        `*${creatorFeeNote}*\n` +
        `*Trade:* ${safeDesc}\n\n` +
        `📤 *Share this invite link with your counterparty:*\n${inviteLink}`,
        { 
          parse_mode: 'Markdown', disable_web_page_preview: true,
          ...Markup.inlineKeyboard([[Markup.button.callback('✏️ Edit Amount', `edit_amount:${escrow.escrow_id}`)]])
        }
      );

      if (escrow.creator_role === 'Buyer') {
        let buyer;
        try { buyer = await getUserByTelegramId(ctx.from.id); } catch { buyer = null; }
        if (!buyer?.default_ln_address) {
          setState(ctx.from.id, 'AWAITING_BUYER_LN_ADDRESS', { escrowId: escrow.escrow_id, context: 'post_creation' });
          await ctx.reply(
            '📬 *One more thing.*\n\nSince you\'re the Buyer, we need your Lightning Address for automatic refunds in case the trade is cancelled or a dispute is resolved in your favour.\n\nWhat is your Lightning Address? Just type it below.\n\n_Example: alice@blink.sv_',
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⏭ Skip for now', 'menu:main')]]) }
          );
        }
      }
    } catch (err) {
      console.error('[create escrow]', err);
      clearState(ctx.from.id);
      await ctx.reply('❌ Failed to create the escrow. Please try again.', { ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Main Menu', 'menu:main')]]) });
    }
    return;
  }

  if (state.step === 'AWAITING_BOLT11') {
    if (!text.toLowerCase().startsWith('ln') || text.includes(' ')) return ctx.reply("That doesn't look like a valid BOLT11 invoice. Paste the full invoice starting with `ln`.", { parse_mode: 'Markdown' });
    const { escrowId, amountSats } = state.data;
    try {
      await payBolt11Invoice({ paymentRequest: text, memo: `Escrow payout: ${escrowId}` });
      await setPayoutSuccessful(escrowId);
      clearState(ctx.from.id);
      const amountKes = await satsToKes(amountSats);
      await ctx.reply(
        `✅ *Payment sent!*\n\n${amountSats.toLocaleString()} sats (~KES ${amountKes.toLocaleString()}) are on their way.`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Main Menu', 'menu:main')]]) }
      );
    } catch (err) {
      console.error('[bolt11 payout]', err);
      await ctx.reply(`❌ Payment failed: ${err.message}\n\nPlease paste a fresh BOLT11 invoice.`);
    }
    return;
  }

  clearState(ctx.from.id);
  return sendMainMenu(ctx, false);
});

bot.catch((err, ctx) => {
  console.error(`[bot] Unhandled error for update ${ctx.update?.update_id}:`, err);
  ctx.reply('⚠️ Something went wrong. Please try again.').catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// Startup Recovery
// ─────────────────────────────────────────────────────────────────────────────

async function recoverPendingPayouts() {
  let pendingEscrows;
  try { pendingEscrows = await getSettledUnpaidEscrows(); } 
  catch (err) { return console.error('[recovery] Failed to query settled unpaid escrows:', err.message); }
  
  if (pendingEscrows.length === 0) return console.log('[recovery] No pending payouts found.');
  console.log(`[recovery] Found ${pendingEscrows.length} settled escrow(s) with unpaid payouts. Re-attempting…`);
  
  for (const escrow of pendingEscrows) {
    const escrowId         = escrow.escrow_id;
    const sellerTelegramId = escrow.creator_role === 'Seller' ? escrow.creator_id : escrow.invitee_id;
    if (!sellerTelegramId) continue;
    
    const { sellerFeeSats }  = splitPlatformFee(escrow.platform_fee_sats);
    const sellerPayoutSats   = escrow.amount_sats - sellerFeeSats;
    const payoutKes          = await satsToKes(sellerPayoutSats).catch(() => 0);
    const safeDesc           = escapeMd(escrow.trade_description);
    
    let sellerUser;
    try { sellerUser = await getUserByTelegramId(sellerTelegramId); } catch (err) { continue; }
    
    if (sellerUser.default_ln_address) {
      console.log(`[recovery] Retrying payout for escrow ${escrowId} → ${sellerUser.default_ln_address}`);
      try {
        await payToLightningAddress({ lnAddress: sellerUser.default_ln_address, amountSats: sellerPayoutSats, memo: `Recovered escrow payout: ${escrow.trade_description}` });
        await setPayoutSuccessful(escrowId);
        await bot.telegram.sendMessage(sellerTelegramId, `🎉 *Your payment has arrived!*\n\n${sellerPayoutSats.toLocaleString()} sats (~KES ${payoutKes.toLocaleString()}) from trade "${safeDesc}" have landed in your Lightning Address.\n\n_(This was a delayed payout — sorry for the wait.)_`, { parse_mode: 'Markdown' }).catch(()=>{});
      } catch (payErr) {
        setState(sellerTelegramId, 'AWAITING_BOLT11', { escrowId, amountSats: sellerPayoutSats });
        await bot.telegram.sendMessage(sellerTelegramId, `⚠️ *Funds Waiting — Action Required*\n\nYou have *${sellerPayoutSats.toLocaleString()} sats* (~KES ${payoutKes.toLocaleString()}) unclaimed from trade "${safeDesc}".\n\nAutomatic payout failed. Please paste a BOLT11 invoice for *${sellerPayoutSats.toLocaleString()} sats* below to claim your funds.`, { parse_mode: 'Markdown' }).catch(()=>{});
      }
    } else {
      setState(sellerTelegramId, 'AWAITING_BOLT11', { escrowId, amountSats: sellerPayoutSats });
      await bot.telegram.sendMessage(sellerTelegramId, `⚠️ *Unclaimed Funds — Action Required*\n\nYou have *${sellerPayoutSats.toLocaleString()} sats* (~KES ${payoutKes.toLocaleString()}) waiting from trade "${safeDesc}".\n\nNo Lightning Address is saved on your account. Paste a BOLT11 invoice for *${sellerPayoutSats.toLocaleString()} sats* below to claim your funds now.`, { parse_mode: 'Markdown' }).catch(()=>{});
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Express Server & Webhook (EXPLICIT POST FIX)
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.post(WEBHOOK_PATH, (req, res, next) => {
  console.log('[webhook] Received update from Telegram!'); 
  return bot.webhookCallback(WEBHOOK_PATH, {
    secretToken: config.TELEGRAM_WEBHOOK_SECRET,
  })(req, res, next);
});

app.use((req, res) => {
  console.log(`[express] 404 Not Found on path: ${req.path}`);
  res.status(404).send('Not Found');
});

// ─────────────────────────────────────────────────────────────────────────────
// Startup
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