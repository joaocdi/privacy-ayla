/**
 * ÁREA VIP COM SUPABASE STORAGE PRIVADO.
 *
 * O que precisa ser verdade:
 *  1. sem assinatura ativa, nem chega a existir uma signed URL;
 *  2. o object path vem SÓ do catálogo do servidor — nunca do cliente;
 *  3. a service role key não aparece em lugar nenhum que o navegador veja;
 *  4. produção sem credenciais não sobe.
 *
 * O Supabase é simulado (global.fetch trocado). Nenhuma requisição real,
 * nenhum bucket criado, nenhum upload.
 */
require('./sqlite-env');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');

const directory = path.resolve(__dirname, '..', '.test-runs');
fs.mkdirSync(directory, { recursive: true });
process.env.DATABASE_PATH = path.join(directory, 'vipsb-' + crypto.randomUUID() + '.sqlite');
process.env.PAYMENT_PROVIDER = 'mock';
process.env.NODE_ENV = 'test';
process.env.ENABLE_TELEGRAM_BOT = 'false';
process.env.FRONTEND_URL = 'http://localhost:5500';

// Driver de produção, com credenciais falsas de teste.
process.env.VIP_MEDIA_DRIVER = 'supabase';
process.env.SUPABASE_URL = 'https://projeto-de-teste.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-de-teste-nao-e-real';
process.env.VIP_MEDIA_BUCKET = 'vip-ayla';
process.env.SUPABASE_SIGNED_URL_TTL = '120';
process.env.VIP_MEDIA_SECRET = crypto.randomBytes(32).toString('hex');

const vipContent = require('../vip-content');
vipContent.posts.length = 0;
vipContent.posts.push(
  { id: 1, type: 'image', source: 'ayla/post-01.jpg', caption: 'post de teste', likes: 10, comments: 2 },
  { id: 2, type: 'video', source: 'ayla/post-02.mp4', caption: 'vídeo', likes: 5, comments: 1 },
  { id: 3, type: 'image', source: 'ayla/post-99.jpg', caption: 'ainda não subiu', draft: true },
  { id: 4, type: 'cta', variant: 'whatsapp', title: 't', text: 'x', button: 'B' }
);

const vipMedia = require('../services/vip-media');
const { app } = require('../server');
const { initDb, getDb, closeDb } = require('../db/database');
const { createOrder, updateOrderPayment } = require('../services/orders');
const { confirmPayment } = require('../services/entitlements');
const mockProvider = require('../payments/mock-provider');

let server;
let base;
let pass = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) throw new Error('FALHOU: ' + name);
  pass += 1;
};

/* ------------------------------------------------- Supabase de mentirinha */

const realFetch = global.fetch;
let storageCalls = [];

function fakeSupabase() {
  storageCalls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (!target.startsWith(process.env.SUPABASE_URL)) return realFetch(url, options);

    storageCalls.push({ url: target, headers: options.headers || {}, body: JSON.parse(options.body || '{}') });
    const objectPath = target.split('/storage/v1/object/sign/')[1];
    return {
      ok: true,
      status: 200,
      json: async () => ({ signedURL: `/object/sign/${objectPath}?token=jwt-de-teste` })
    };
  };
}

async function request(route, token, redirect = 'manual') {
  const response = await realFetch(base + route, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
    redirect
  });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch (_) { body = { raw: text }; }
  return { status: response.status, location: response.headers.get('location'), body, text };
}

async function pedidoPago() {
  const token = crypto.randomBytes(32).toString('hex');
  const order = await createOrder(require('../products').ayla_monthly, token, 'mock');
  await updateOrderPayment(order.public_id, await mockProvider.createPixPayment({ orderId: order.public_id }));
  await confirmPayment(order.public_id);
  return { token, publicId: order.public_id, id: order.id };
}

async function main() {
  fakeSupabase();
  await initDb();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;

  /* -------------------------------------------------- seleção do driver */
  check('driver supabase selecionado por env', vipMedia.driverName() === 'supabase');
  check('driver local continua existindo e íntegro', typeof vipMedia.resolveSource === 'function'
    && vipMedia.mediaRoots().includes('Media_Ayla'));

  /* ------------------------------------------------------------- feed */
  const assinante = await pedidoPago();
  const vip = await request(`/api/vip/${assinante.publicId}`, assinante.token);
  check('assinante recebe o feed', vip.status === 200 && vip.body.granted === true);
  check('post em draft não entra no feed', !vip.body.feed.some((post) => post.id === 3));
  check('nenhuma chamada ao Storage ao montar o feed', storageCalls.length === 0,
    'a URL assinada só nasce quando a mídia é pedida');

  const corpoFeed = JSON.stringify(vip.body);
  check('feed não expõe object path do bucket', !corpoFeed.includes('ayla/post-01.jpg'));
  check('feed não expõe a URL do Supabase', !corpoFeed.includes('supabase.co'));
  check('feed não expõe o nome do bucket', !corpoFeed.includes('vip-ayla'));
  check('feed não expõe a service role key', !corpoFeed.includes(process.env.SUPABASE_SERVICE_ROLE_KEY));

  /* ------------------------------------------------------- signed URL */
  const media = vip.body.feed.find((post) => post.id === 1).media;
  const redirect = await request(media);
  check('mídia responde com redirect 302', redirect.status === 302);
  check('redirect aponta para a signed URL do Supabase',
    (redirect.location || '').startsWith('https://projeto-de-teste.supabase.co/storage/v1/object/sign/'));
  check('a URL assinada carrega token', (redirect.location || '').includes('token='));
  check('nada é proxiado pela função', redirect.text.length < 200);

  check('uma única chamada ao Storage', storageCalls.length === 1);
  const call = storageCalls[0];
  check('o object path veio do catálogo do servidor', call.url.includes('/vip-ayla/ayla/post-01.jpg'));
  check('a chamada usa a service role key só no servidor',
    call.headers.Authorization === 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY);
  check('a URL assinada tem expiração curta',
    call.body.expiresIn === 120 && call.body.expiresIn >= 60 && call.body.expiresIn <= 300,
    `expiresIn=${call.body.expiresIn}`);

  // TTL fora da faixa é normalizado, não obedecido às cegas.
  const anterior = process.env.SUPABASE_SIGNED_URL_TTL;
  process.env.SUPABASE_SIGNED_URL_TTL = '86400';
  check('TTL exagerado é limitado a 300s', vipMedia.signedUrlTtl() === 300);
  process.env.SUPABASE_SIGNED_URL_TTL = '5';
  check('TTL curto demais sobe para 60s', vipMedia.signedUrlTtl() === 60);
  process.env.SUPABASE_SIGNED_URL_TTL = anterior;

  /* -------------------------------------------- autorização antes de tudo */
  storageCalls = [];
  check('token de mídia adulterado não gera URL', (await request(media.slice(0, -3) + 'xyz')).status === 403);
  check('link forjado não gera URL', (await request(`/api/vip/media/${'a'.repeat(30)}.${'b'.repeat(30)}`)).status === 403);

  const pendente = await createOrder(require('../products').ayla_monthly, crypto.randomBytes(32).toString('hex'), 'mock');
  const linkPendente = vipMedia.signLink(pendente.public_id, 1);
  check('pedido sem pagamento não gera URL', (await request(`/api/vip/media/${linkPendente}`)).status === 403);

  const inexistente = vipMedia.signLink('ord_nao_existe', 1);
  check('pedido inexistente não gera URL', (await request(`/api/vip/media/${inexistente}`)).status === 403);

  const postInexistente = vipMedia.signLink(assinante.publicId, 4242);
  check('post inexistente não gera URL', (await request(`/api/vip/media/${postInexistente}`)).status === 404);

  const postCta = vipMedia.signLink(assinante.publicId, 4);
  check('bloco de CTA não gera URL', (await request(`/api/vip/media/${postCta}`)).status === 404);

  check('nenhuma dessas tentativas tocou o Storage', storageCalls.length === 0);

  /* ------------------------------------------- caminho arbitrário recusado */
  for (const malicioso of [
    '../../etc/passwd', '/etc/passwd', 'ayla/../../secret.jpg', 'ayla//post.jpg',
    'C:\\Windows\\win.ini', 'ayla/post\u0000.jpg', './post.jpg', ''
  ]) {
    check(`object path recusado: ${JSON.stringify(malicioso)}`, vipMedia.safeObjectPath(malicioso) === null);
  }
  check('object path legítimo é aceito', vipMedia.safeObjectPath('ayla/post-01.jpg') === 'ayla/post-01.jpg');

  // O cliente não tem por onde injetar caminho: o id do post vem de dentro do
  // HMAC e o caminho vem do catálogo. Um id que não existe no catálogo é 404.
  const forjado = vipMedia.signLink(assinante.publicId, '../../secret');
  check('id de post forjado não vira object path', (await request(`/api/vip/media/${forjado}`)).status === 404);
  check('e nada foi pedido ao Storage', storageCalls.length === 0);

  /* --------------------------------------------------------- expirado */
  await (await getDb()).run(
    "UPDATE entitlements SET expires_at=datetime('now','-1 minute') WHERE order_id=?", assinante.id
  );
  check('entitlement expirado não gera URL', (await request(media)).status === 403);
  check('Storage segue intocado', storageCalls.length === 0);

  /* ------------------------------------------------ segredo no frontend */
  const raiz = path.resolve(__dirname, '..', '..');
  for (const arquivo of ['vip.html', 'vip.js', 'vip.css', 'index.html', 'app.js']) {
    const conteudo = fs.readFileSync(path.join(raiz, arquivo), 'utf8');
    check(`${arquivo} não contém credencial nem URL do Supabase`,
      !/SUPABASE|service_role|supabase\.co/i.test(conteudo));
  }

  /* --------------------------------- produção sem credenciais não sobe */
  const semCredenciais = spawnSync(process.execPath, ['-e', "require('./services/vip-media').assertConfigured()"], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      PATH: process.env.PATH, NODE_ENV: 'production', VIP_MEDIA_DRIVER: 'supabase',
      VIP_MEDIA_SECRET: process.env.VIP_MEDIA_SECRET, DOTENV_CONFIG_QUIET: 'true'
    },
    encoding: 'utf8'
  });
  check('produção com supabase sem credenciais recusa iniciar', semCredenciais.status !== 0);
  check('e a mensagem diz o que falta', /SUPABASE_URL/.test(semCredenciais.stderr),
    (semCredenciais.stderr || '').split('\n').find((line) => line.includes('Error')) || '');

  const driverInvalido = spawnSync(process.execPath, ['-e', "require('./services/vip-media').assertConfigured()"], {
    cwd: path.resolve(__dirname, '..'),
    env: { PATH: process.env.PATH, NODE_ENV: 'production', VIP_MEDIA_DRIVER: 'publico',
      VIP_MEDIA_SECRET: process.env.VIP_MEDIA_SECRET },
    encoding: 'utf8'
  });
  check('driver desconhecido não vira fallback público', driverInvalido.status !== 0);

  const semSegredo = spawnSync(process.execPath, ['-e', "require('./services/vip-media').assertConfigured()"], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      PATH: process.env.PATH, NODE_ENV: 'production', VIP_MEDIA_DRIVER: 'supabase',
      SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', VIP_MEDIA_BUCKET: 'b'
    },
    encoding: 'utf8'
  });
  check('produção sem VIP_MEDIA_SECRET recusa iniciar', semSegredo.status !== 0);

  /* ------------------------------------------- falha do Storage é tratada */
  // Reativa o acesso para chegar até o Storage e ver o que acontece quando ele
  // responde erro: precisa virar erro nosso, nunca 200 nem vazamento.
  await (await getDb()).run(
    "UPDATE entitlements SET expires_at=datetime('now','+30 days') WHERE order_id=?", assinante.id
  );
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const falha = await request(`/api/vip/media/${vipMedia.signLink(assinante.publicId, 1)}`);
  check('falha do Storage não vira 200', falha.status >= 400 && falha.status < 600, `status ${falha.status}`);
  check('e o erro não expõe bucket, URL nem chave',
    !/supabase\.co|vip-ayla|service-role/i.test(falha.text), falha.text.slice(0, 120));

  console.log(`\nPASS: VIP + Supabase Storage privado — ${pass} verificações`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    global.fetch = realFetch;
    if (server) await new Promise((resolve) => server.close(resolve));
    await closeDb();
  });
