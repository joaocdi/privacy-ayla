const { getDb, transaction } = require('../db/database');
const crypto = require('crypto');

/**
 * Gera um novo access token para o pedido.
 *
 * Como só guardamos o hash, não é possível reexibir um token antigo. Então, ao
 * emitir um novo, todos os tokens ainda NÃO consumidos daquele pedido são
 * invalidados — assim nunca existe mais de um link de acesso válido por pedido.
 * Tokens já consumidos são preservados (histórico/auditoria).
 */
async function generateAccessToken(orderId) {
  return transaction(async db => {
  const access = await db.get("SELECT o.id FROM orders o JOIN entitlements e ON e.order_id=o.id WHERE o.id=? AND o.status='PAID' AND e.status='ACTIVE' AND (e.expires_at IS NULL OR e.expires_at>CURRENT_TIMESTAMP) AND e.telegram_user_id IS NULL", orderId);
  if (!access) throw new Error('Acesso negado.');

  await db.run(
    `UPDATE access_tokens
        SET expires_at = datetime('now', '-1 second')
      WHERE order_id = ? AND used_at IS NULL`,
    [orderId]
  );

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  await db.run(
    `INSERT INTO access_tokens (order_id, token_hash, expires_at)
     VALUES (?, ?, datetime('now', '+1 hour'))`,
    [orderId, tokenHash]
  );

  return rawToken;
  });
}

async function validateAndConsumeToken(rawToken, telegramUserId) {
  if (typeof rawToken !== 'string' || rawToken.length > 128) return { valid: false, error: 'Token inválido.' };
  return transaction(async db => {
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const record = await db.get('SELECT * FROM access_tokens WHERE token_hash=?', tokenHash);
    if (!record) return { valid: false, error: 'Token não encontrado.' };
    const expired = await db.get('SELECT id FROM access_tokens WHERE id=? AND expires_at>CURRENT_TIMESTAMP', record.id);
    if (!expired) return { valid: false, error: 'Token expirado.' };
    const user = String(telegramUserId);
    if (record.used_at && record.telegram_user_id !== user) return { valid: false, error: 'Token já foi utilizado por outra conta.' };
    const access = await db.get("SELECT e.* FROM entitlements e JOIN orders o ON o.id=e.order_id WHERE o.id=? AND o.status='PAID' AND o.access_type='vip' AND e.status='ACTIVE' AND (e.expires_at IS NULL OR e.expires_at>CURRENT_TIMESTAMP)", record.order_id);
    if (!access) return { valid: false, error: 'Acesso expirado ou não autorizado.' };
    if (access.telegram_user_id && access.telegram_user_id !== user) return { valid: false, error: 'Acesso vinculado a outra conta.' };
    await db.run('UPDATE access_tokens SET used_at=COALESCE(used_at,CURRENT_TIMESTAMP), telegram_user_id=? WHERE id=?', user, record.id);
    await db.run('UPDATE entitlements SET telegram_user_id=? WHERE id=?', user, access.id);
    return { valid: true, order_id: record.order_id };
  });
}
module.exports = { generateAccessToken, validateAndConsumeToken };
