// Rascunho, exclusão e contadores do perfil.
//  - rascunho nunca aparece para visitante nem para assinante;
//  - excluir apaga de verdade e NÃO volta no próximo boot (feed legado não
//    é reimportado depois que o painel assume);
//  - contadores vêm do conteúdo real + base histórica, e o número curto do
//    frontend aguenta 27K/1M sem quebrar;
//  - /favicon.ico responde.
// SQLite isolado, nenhum serviço externo, nenhuma cobrança.
require('./sqlite-env');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
process.env.DATABASE_PATH = path.resolve(__dirname, '../.test-runs/conteudo-' + crypto.randomUUID() + '.sqlite');
process.env.PAYMENT_PROVIDER = 'mock';
process.env.VIP_MEDIA_DRIVER = 'local';
process.env.VIP_MEDIA_DIRS = 'previews';
const { app } = require('../server');
const { getDb, closeDb, initDb } = require('../db/database');
const posts = require('../services/vip-posts');
const profile = require('../services/profile');
const legacy = require('../vip-content');

/** compactNumber vive no app.js do navegador; aqui é avaliado direto do arquivo. */
function loadCompactNumber() {
  const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'app.js'), 'utf8');
  const start = source.indexOf('function compactNumber');
  const end = source.indexOf('function applyProfile');
  assert.ok(start > 0 && end > start, 'compactNumber existe no app.js');
  return eval('(' + source.slice(start, end).trim() + ')');
}

async function seedPost(db, { id, published, type = 'image', likes = 0 }) {
  await db.run(`INSERT INTO vip_posts(id,type,media_path,media_driver,caption,sort_order,published,likes_count)
    VALUES (?,?,?,?,?,?,?,?)`, id, type, 'ayla/posts/' + id + '.jpg', 'local', 'legenda ' + id, 0, published ? 1 : 0, likes);
  await db.run(`INSERT INTO vip_post_media(id,post_id,sort_order,type,media_path,media_driver)
    VALUES (?,?,?,?,?,?)`, id + '-m1', id, 0, type, 'ayla/posts/' + id + '.jpg', 'local');
  return db.get('SELECT * FROM vip_posts WHERE id=?', id);
}

(async () => {
  await initDb();
  const db = await getDb();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    // --------------------------------------------- o feed legado não semeia nada
    assert.deepEqual(legacy.posts, [], 'sem rascunho-placeholder inventado no código');
    assert.equal(await posts.migrate(), 0, 'nada a importar do feed antigo');

    await posts.setSource('managed');
    const draft = await seedPost(db, { id: 'rascunho-1', published: false });
    const live = await seedPost(db, { id: 'publicado-1', published: true, likes: 27000 });

    // ------------------------------------------------- rascunho só no painel
    const publico = await posts.homePreviews();
    assert.ok(!publico.some(p => p.id === 'rascunho-1'), 'HOME não mostra rascunho');
    const assinante = await posts.feed();
    assert.ok(!assinante.some(p => p.id === 'rascunho-1'), 'VIP do assinante não mostra rascunho');
    assert.ok(assinante.some(p => p.id === 'publicado-1'), 'publicado aparece para o assinante');
    const painel = await posts.adminFeed();
    assert.ok(painel.some(p => p.id === 'rascunho-1' && p.draft === true), 'painel mostra o rascunho marcado');

    // ----------------------------------------------------- exclusão definitiva
    const removed = await posts.deletePermanent('rascunho-1', draft.version);
    assert.equal(removed.deleted, true);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM vip_posts WHERE id=?', 'rascunho-1')).n, 0, 'registro apagado');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM vip_post_media WHERE post_id=?', 'rascunho-1')).n, 0, 'mídia do rascunho apagada');
    await assert.rejects(posts.deletePermanent('rascunho-1', draft.version), /não encontrada/, 'excluir de novo não explode');

    // apagar TUDO e "reiniciar": o feed antigo não pode voltar
    await posts.deletePermanent('publicado-1', live.version);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM vip_posts')).n, 0);
    const reboot = await posts.adoptLegacyOnce();
    assert.equal(reboot.imported, 0, 'boot não reimporta o feed antigo');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM vip_posts')).n, 0, 'feed continua vazio depois do boot');

    // ------------------------------------------------------------ contadores
    await seedPost(db, { id: 'foto-1', published: true, likes: 27000 });
    await seedPost(db, { id: 'foto-2', published: true, likes: 400 });
    await seedPost(db, { id: 'video-1', published: true, type: 'video', likes: 0 });
    const oculto = await seedPost(db, { id: 'rascunho-2', published: false });
    const pedido = await require('../services/orders').createOrder(require('../products').ayla_monthly, crypto.randomBytes(32).toString('hex'), 'mock');
    await db.run('INSERT INTO vip_post_likes(id,post_id,order_id) VALUES (?,?,?)', crypto.randomUUID(), 'foto-1', pedido.id);
    const stats = await profile.stats();
    // Base histórica configurada em vip-content.js + conteúdo real publicado.
    const cfg = legacy.profile.stats;
    const numero = v => Number(String(v).replace(/[^0-9]/g, '')) || 0;
    assert.deepEqual(stats, {
      posts: numero(cfg.posts) + 3,
      photos: numero(cfg.photos) + 2,
      videos: numero(cfg.videos) + 1,
      likes: numero(cfg.likes) + 27401
    }, 'base histórica + publicado, somando curtidas reais');
    assert.ok(numero(cfg.likes) >= 23000 && numero(cfg.posts) > 0,
      'base histórica configurada deixa o perfil acima de 28K curtidas com as curtidas reais');
    const perfil = await (await fetch(base + '/api/profile')).json();
    assert.deepEqual(perfil.stats, stats, '/api/profile entrega os mesmos números');
    assert.ok(oculto, 'rascunho existe, mas fora da contagem');

    const compact = loadCompactNumber();
    assert.deepEqual([0, 999, 1000, 5200, 27000, 27401, 100000, 1000000].map(compact),
      ['0', '999', '1K', '5,2K', '27K', '27,4K', '100K', '1M']);

    // ---------------------------------------------------------------- favicon
    const favicon = await fetch(base + '/favicon.ico');
    assert.equal(favicon.status, 200, '/favicon.ico responde');
    assert.ok(Number(favicon.headers.get('content-length')) > 100, 'favicon tem conteúdo');
    assert.ok(fs.readFileSync(path.resolve(__dirname, '..', '..', 'index.html'), 'utf8').includes('rel="icon"'), 'HOME declara o ícone');

    console.log('PASS conteúdo Ayla: sem placeholder no código, rascunho só no painel, exclusão definitiva e idempotente, '
      + 'feed antigo não volta no boot, contadores reais (27,4K) e /favicon.ico 200');
  } finally {
    server.close();
    await closeDb();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
