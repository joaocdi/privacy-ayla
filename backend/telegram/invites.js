/**
 * Convites e remoção de membros do canal VIP.
 *
 * Ajustado para a API da node-telegram-bot-api 2.x: os métodos ficam em
 * `bot.api.*` e recebem um único objeto de parâmetros (snake_case), não
 * argumentos posicionais.
 */

async function createInviteLink(bot, chatId) {
  try {
    // Link de uso único, válido por 15 minutos
    const expireDate = Math.floor(Date.now() / 1000) + (15 * 60);

    const inviteLink = await bot.api.createChatInviteLink({
      chat_id: chatId,
      member_limit: 1,
      expire_date: expireDate,
      name: 'Acesso VIP'
    });

    return inviteLink.invite_link;
  } catch (error) {
    console.error('Erro ao gerar invite link:', error);
    throw new Error('Falha ao gerar link de convite.');
  }
}

/**
 * Remove o usuário do canal.
 *
 * A API do Telegram não tem um "kick" direto: é preciso banir (o que remove o
 * membro) e em seguida desbanir, para que ele possa entrar de novo caso compre
 * outra vez. Só o unbanChatMember, como estava antes, NÃO removia ninguém.
 */
async function kickUser(bot, chatId, userId) {
  try {
    await bot.api.banChatMember({
      chat_id: chatId,
      user_id: Number(userId)
    });

    // Desbanir logo em seguida libera uma futura reentrada com novo convite.
    await bot.api.unbanChatMember({
      chat_id: chatId,
      user_id: Number(userId),
      only_if_banned: true
    });

    console.log(`Usuário ${userId} removido do canal ${chatId}`);
  } catch (error) {
    console.error(`Erro ao remover usuário ${userId}:`, error.message);
  }
}

module.exports = {
  createInviteLink,
  kickUser
};
