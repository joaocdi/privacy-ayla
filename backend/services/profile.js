const { getDb, transaction } = require('../db/database');
const defaults = require('../vip-content').profile;
const crop = require('./crop');
const cleanup = require('./media-cleanup');
const { fail } = require('./vip-posts');

async function read(db) {
  return (db || await getDb()).get("SELECT * FROM creator_profiles WHERE id='ayla'");
}
function present(row) {
  return { name: row?.name ?? defaults.name, username: row?.username ?? defaults.username,
    bio: row?.bio ?? defaults.bio, verified: Boolean(defaults.verified), stats: defaults.stats,
    avatarCrop: crop.read(row?.avatar_crop, 'avatar'), coverCrop: crop.read(row?.cover_crop, 'cover'),
    avatar: '/api/profile/media/avatar?v=' + (row?.version || 0),
    cover: '/api/profile/media/cover?v=' + (row?.version || 0), version: row?.version || 0 };
}
/**
 * Contadores do perfil: conteúdo REAL publicado + a base histórica do perfil.
 *
 * Nada fica fixo no frontend. `defaults.stats.likes` é o total histórico
 * configurado (pode ser 0); as curtidas reais são somadas a ele. Fotos, vídeos
 * e publicações contam só o que está publicado e não arquivado.
 */
async function stats(db = null) {
  const conn = db || await getDb();
  const inteiro = valor => Number(String(valor ?? 0).replace(/[^0-9]/g, '')) || 0;
  const base = inteiro(defaults.stats?.likes);
  const baseConteudo = { posts: inteiro(defaults.stats?.posts), photos: inteiro(defaults.stats?.photos), videos: inteiro(defaults.stats?.videos) };
  const posts = Number((await conn.get("SELECT COUNT(*) AS n FROM vip_posts WHERE creator_id='ayla' AND published=1 AND archived=0")).n) || 0;
  const rows = await conn.all(`SELECT m.type AS type, COUNT(*) AS n FROM vip_post_media m
    JOIN vip_posts p ON p.id=m.post_id
    WHERE p.creator_id='ayla' AND p.published=1 AND p.archived=0 GROUP BY m.type`);
  const byType = Object.fromEntries(rows.map(row => [row.type, Number(row.n) || 0]));
  const counted = Number((await conn.get(`SELECT COALESCE(SUM(likes_count),0) AS historic,
      (SELECT COUNT(*) FROM vip_post_likes l JOIN vip_posts q ON q.id=l.post_id
        WHERE q.creator_id='ayla' AND q.published=1 AND q.archived=0) AS reais
    FROM vip_posts WHERE creator_id='ayla' AND published=1 AND archived=0`)).historic) || 0;
  const reais = Number((await conn.get(`SELECT COUNT(*) AS n FROM vip_post_likes l JOIN vip_posts q ON q.id=l.post_id
    WHERE q.creator_id='ayla' AND q.published=1 AND q.archived=0`)).n) || 0;
  return {
    posts: baseConteudo.posts + posts,
    photos: baseConteudo.photos + (byType.image || 0),
    videos: baseConteudo.videos + (byType.video || 0),
    likes: base + counted + reais
  };
}

async function get() {
  // HOME e VIP mostram os mesmos contadores, vindos do conteúdo real.
  const row = await read();
  return { ...present(row), stats: await stats() };
}
async function save(body, sessionId) {
  for (const [key, max] of [['name',80], ['username',80], ['bio',4000]]) {
    if (typeof body[key] !== 'string' || body[key].length > max || (key !== 'bio' && !body[key].trim())) throw fail('Preencha nome, username e bio dentro dos limites.', 400);
  }
  if (!/^@[A-Za-z0-9._]{1,79}$/.test(body.username)) throw fail('Use @ seguido de letras, números, ponto ou sublinhado.', 400);
  if (!Number.isInteger(body.version) || body.version < 0) throw fail('Recarregue o perfil antes de salvar.', 409);
  return transaction(async db => {
    await cleanup.lock(db);
    await db.run("INSERT INTO creator_profiles(id,name,username,bio) VALUES ('ayla',?,?,?) ON CONFLICT(id) DO NOTHING", defaults.name, defaults.username, defaults.bio);
    const current = await read(db);
    const paths = {};
    for (const role of ['avatar','cover']) {
      paths[role] = current[role + '_path'];
      if (body[role + 'UploadId'] !== undefined) {
        const id = body[role + 'UploadId'];
        if (typeof id !== 'string') throw fail('Imagem inválida.', 400);
        const upload = await db.get('SELECT * FROM vip_uploads WHERE id=? AND session_id=? AND complete=1', id, sessionId);
        if (!upload || upload.type !== 'image' || !['image/jpeg','image/png','image/webp'].includes(upload.mime_type)) throw fail('Selecione uma imagem enviada nesta sessão.', 400);
        paths[role] = upload.media_path;
        await cleanup.usable(db, upload.media_path);
      }
    }
    const result = await db.run("UPDATE creator_profiles SET name=?,username=?,bio=?,avatar_path=?,cover_path=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id='ayla' AND version=?",
      body.name.trim(), body.username.trim(), body.bio, paths.avatar, paths.cover, body.version);
    if (!result.changes) throw fail('O perfil mudou em outra janela. Recarregue antes de salvar.', 409);
    for (const role of ['avatar','cover']) {
      const value = body[role + 'Crop'] === undefined ? crop.read(current[role + '_crop'],role) : crop.normalize(body[role + 'Crop'],role);
      await db.run(`UPDATE creator_profiles SET ${role}_crop=? WHERE id='ayla'`,JSON.stringify(value));
    }
    return present(await read(db));
  });
}
async function image(role) {
  if (!['avatar','cover'].includes(role)) throw fail('Imagem não encontrada.', 404);
  const row = await read();
  return { path: row?.[role + '_path'] || null, fallback: defaults[role], version: row?.version || 0 };
}
module.exports = { stats, get, save, image };
