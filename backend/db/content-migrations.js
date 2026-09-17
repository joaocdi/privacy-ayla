// Additive and shared across database drivers. Existing media bytes remain untouched.
// preview_video guarda o CAMINHO da derivada de vídeo (ayla/previews/...),
// nunca o caminho do original. São dois arquivos independentes no Storage.
const columns = { vip_posts: { crop_data: 'TEXT', preview_video: 'TEXT' }, creator_profiles: { avatar_crop: 'TEXT', cover_crop: 'TEXT' } };
async function migrate(db, postgres = false) {
  for (const [table, fields] of Object.entries(columns)) {
    const existing = postgres ? null : new Set((await db.all(`PRAGMA table_info(${table})`)).map(c => c.name));
    for (const [field, type] of Object.entries(fields)) {
      if (!existing || !existing.has(field)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${postgres ? 'IF NOT EXISTS ' : ''}${field} ${type}`);
    }
  }
}

/**
 * A mídia única de cada publicação vira o item 1 do carrossel.
 *
 * Copia, não move: as colunas antigas de `vip_posts` continuam preenchidas e o
 * backend ainda sabe lê-las se um post não tiver item nenhum. Enquanto as duas
 * formas existirem, nada quebra — remover as colunas antigas é decisão de uma
 * fase futura, depois que o modelo novo estiver provado no ar.
 *
 * Idempotente pelo `NOT EXISTS`: roda de novo à vontade, não duplica item e não
 * encosta em publicação que já ganhou mídias pelo painel. O enquadramento, a
 * amostra da HOME e o teaser vêm junto — nada é regerado à toa.
 *
 * O SQL é o mesmo nos dois bancos: `||` concatena em SQLite e em PostgreSQL.
 */
async function backfillMedia(db) {
  const result = await db.run(`INSERT INTO vip_post_media
      (id, post_id, type, media_path, media_driver, sort_order, crop_data, preview_image, preview_video)
    SELECT 'item-' || p.id, p.id, p.type, p.media_path, p.media_driver, 0,
           p.crop_data, p.preview_image, p.preview_video
      FROM vip_posts p
     WHERE p.media_path IS NOT NULL AND p.media_path <> ''
       AND NOT EXISTS (SELECT 1 FROM vip_post_media m WHERE m.post_id = p.id)`);
  return Number(result?.changes || 0);
}

module.exports = { migrate, backfillMedia };
