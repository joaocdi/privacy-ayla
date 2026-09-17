const { getDb } = require('../db/database');
const { getActiveEntitlementByTelegramUserId } = require('../services/entitlements');

async function validateAccess(telegramUserId, tokenRecord, order) {
  // If no token record but we're here, it's failed earlier.
  if (!tokenRecord.valid) {
    return { valid: false, error: tokenRecord.error };
  }

  // Check if order is PAID
  if (order.status !== 'PAID') {
    return { valid: false, error: 'O pedido ainda não está com status pago.' };
  }

  // Check if there's already an active entitlement for THIS specific order
  const db = await getDb();
  const entitlement = await db.get(`SELECT * FROM entitlements WHERE order_id = ?`, [order.id]);

  if (!entitlement) {
    return { valid: false, error: 'Direito de acesso não encontrado.' };
  }

  if (entitlement.status !== 'ACTIVE') {
    return { valid: false, error: 'Este acesso não está mais ativo.' };
  }
  
  // SQLite stores CURRENT_TIMESTAMP as UTC without 'Z'
  const expiresAt = entitlement.expires_at
    ? new Date(entitlement.expires_at.includes('Z') ? entitlement.expires_at : entitlement.expires_at + 'Z')
    : null;

  if (!expiresAt || expiresAt <= new Date()) {
    return { valid: false, error: 'Seu tempo de acesso expirou.' };
  }
  
  // Check if token belongs to another user
  if (entitlement.telegram_user_id && entitlement.telegram_user_id !== telegramUserId.toString()) {
     return { valid: false, error: 'Este acesso já está vinculado a outra conta do Telegram.' };
  }

  return { valid: true, entitlement };
}

module.exports = {
  validateAccess
};
