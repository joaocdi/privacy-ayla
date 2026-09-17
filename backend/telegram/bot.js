/**
 * Integração com o Telegram.
 *
 * IMPORTANTE: a versão instalada da lib (node-telegram-bot-api 2.x) é uma
 * reescrita com API totalmente diferente da 0.x. Não existe mais
 * `new TelegramBot(token, { polling: true })` nem `bot.onText(...)`.
 * Agora usamos a classe `Bot`, middlewares (`bot.command`), o `Context` (ctx)
 * e as chamadas de API em `bot.api.*` recebendo um objeto de parâmetros.
 */
const { validateAndConsumeToken } = require('../services/access-tokens');
const { getDb } = require('../db/database');
const { linkEntitlementToTelegram } = require('../services/entitlements');
const { validateAccess } = require('./access');
const { createInviteLink } = require('./invites');

let bot = null;

function initBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token === 'YOUR_BOT_TOKEN_HERE') {
    console.warn('⚠️ TELEGRAM_BOT_TOKEN não configurado. Bot não iniciado.');
    return null;
  }

  const { Bot } = require('node-telegram-bot-api');
  bot = new Bot(token);

  bot.command('start', async (ctx) => {
    const rawToken = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const telegramUserId = ctx.from ? String(ctx.from.id) : null;

    if (!telegramUserId) return;

    if (!rawToken) {
      return ctx.reply(
        'Olá! Para liberar seu acesso, finalize o pagamento na página e clique em "ACESSAR MEU CONTEÚDO".'
      );
    }


    const tokenResult = await validateAndConsumeToken(rawToken, telegramUserId);
    if (!tokenResult.valid) {
      return ctx.reply(`❌ ${tokenResult.error}`);
    }

    const db = await getDb();
    const order = await db.get(`SELECT * FROM orders WHERE id = ?`, [tokenResult.order_id]);

    if (!order) {
      return ctx.reply('❌ Pedido não encontrado.');
    }

    const accessResult = await validateAccess(telegramUserId, tokenResult, order);
    if (!accessResult.valid) {
      return ctx.reply(`❌ ${accessResult.error}`);
    }

    const entitlement = accessResult.entitlement;

    // Se ainda não estiver vinculado a este user_id, vincular agora
    if (!entitlement.telegram_user_id) {
      await linkEntitlementToTelegram(entitlement.id, telegramUserId);
    }

    // Gerar convite
    const vipChatId = process.env.TELEGRAM_VIP_CHAT_ID;
    if (!vipChatId || vipChatId === 'YOUR_CHAT_ID_HERE') {
      return ctx.reply('⚠️ O canal VIP não está configurado no servidor.');
    }

    const inviteLink = await createInviteLink(bot, vipChatId);

    await ctx.reply(
      `✅ Seu acesso está liberado!\n\nUse o botão abaixo para entrar no conteúdo VIP.\n\n[ ENTRAR NO VIP ](${inviteLink})`,
      { parse_mode: 'Markdown' }
    );

  });

  // Error boundary: um erro em um handler não derruba o polling.
  bot.catch((err, ctx) => {
    console.error('Erro no handler do bot:', err);
    if (ctx && ctx.chatId) {
      ctx.reply('❌ Ocorreu um erro interno ao processar seu acesso. Tente novamente mais tarde.')
        .catch(() => {});
    }
  });

  // startPolling() só resolve quando o bot para; por isso não damos await.
  bot.startPolling().catch((err) => {
    console.error('Falha no long-polling do bot:', err);
  });

  console.log('🤖 Bot do Telegram inicializado.');
  return bot;
}

function getBot() {
  return bot;
}

function stopBot() {
  if (bot && bot.isRunning()) bot.stop();
}

module.exports = {
  initBot,
  getBot,
  stopBot
};
