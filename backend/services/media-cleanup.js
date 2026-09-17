const { transaction } = require('../db/database');
const media = require('./vip-media');
// Shared lock serializes media adoption with deletion, including on PostgreSQL.
async function lock(db) {
  await db.run("INSERT INTO vip_content_settings(id,source) VALUES ('ayla','legacy') ON CONFLICT(id) DO NOTHING");
  await db.run("UPDATE vip_content_settings SET id=id WHERE id='ayla'");
}
async function usable(db, path) {
  if (await db.get('SELECT media_path FROM media_deletions WHERE media_path=?', path)) throw Object.assign(new Error('Esta mídia foi excluída. Envie um novo arquivo.'), {status:409});
}
/**
 * Alguém ainda aponta para este arquivo?
 *
 * Enquanto a resposta for sim, ele não sai do Storage. As referências são, em
 * ordem: a mídia única do modelo antigo, o teaser do modelo antigo, CADA ITEM
 * do carrossel, o teaser de cada item, o avatar, a capa e o feed legado.
 */
async function shared(db, path) {
  // Preview uses the existing private bucket. A preview edit must never
  // delete an object still referenced by the Production schema.
  if (process.env.APP_ENV === 'staging' && process.env.DATABASE_URL) {
    const productionReference = await db.get(`SELECT 1 AS used WHERE
      EXISTS (SELECT 1 FROM ayla.vip_posts WHERE media_path=? OR preview_video=?) OR
      EXISTS (SELECT 1 FROM ayla.vip_post_media WHERE media_path=? OR preview_video=?) OR
      EXISTS (SELECT 1 FROM ayla.creator_profiles WHERE avatar_path=? OR cover_path=?)`,
      path, path, path, path, path, path);
    if (productionReference) return true;
  }
  return Boolean(await db.get('SELECT id FROM vip_posts WHERE media_path=? LIMIT 1', path) ||
    // O teaser da HOME também é uma referência: se outra publicação ainda usa
    // aquele arquivo derivado, ele não pode sumir do Storage.
    await db.get('SELECT id FROM vip_posts WHERE preview_video=? LIMIT 1', path) ||
    // Itens do carrossel: o arquivo e o teaser de cada mídia contam igual.
    await db.get('SELECT id FROM vip_post_media WHERE media_path=? LIMIT 1', path) ||
    await db.get('SELECT id FROM vip_post_media WHERE preview_video=? LIMIT 1', path) ||
    await db.get('SELECT id FROM creator_profiles WHERE avatar_path=? OR cover_path=? LIMIT 1', path, path) ||
    require('../vip-content').posts.some(p => p.source === path));
}
async function clean(path) {
  return transaction(async db => {
    await lock(db);
    const job = await db.get('SELECT status FROM media_deletions WHERE media_path=?',path);
    if (!job || job.status === 'done') return 'done';
    if (await shared(db,path)) return 'shared';
    // Database removal has already committed. Failed Storage cleanup is retryable.
    try { await media.removePrivate(path); } catch (_) { return 'pending'; }
    await db.run("UPDATE media_deletions SET status='done' WHERE media_path=?",path);
    return 'done';
  });
}
module.exports = { lock, usable, shared, clean };
