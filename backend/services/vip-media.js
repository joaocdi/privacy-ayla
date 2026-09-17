/**
 * ENTREGA DA MÍDIA PRIVADA.
 *
 * Regra que não muda: nenhum arquivo pago sai por URL estática. Só existe um
 * caminho para os bytes — um link assinado por nós (HMAC, curta duração,
 * preso a um pedido e a um post), e a assinatura é reconferida no banco a
 * cada requisição, antes de qualquer coisa.
 *
 * Dois drivers atrás da mesma interface:
 *   local      → lê das pastas privadas do projeto, com streaming (desenvolvimento)
 *   supabase   → devolve redirect para uma signed URL do Storage PRIVADO (produção)
 *
 * A escolha é VIP_MEDIA_DRIVER. Nada no feed, na autorização ou no frontend
 * muda entre um e outro.
 *
 * Por que redirect e não proxy: em serverless, passar um vídeo inteiro pela
 * função custa tempo, memória e limite de execução — e ainda quebra o seek.
 * O redirect entrega o arquivo direto do Storage, e a URL morre em segundos.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function driverName() {
  return (process.env.VIP_MEDIA_DRIVER || 'local').toLowerCase();
}

/* ------------------------------------------------------- caminho do objeto */

/**
 * O `source` NUNCA vem do cliente: ele é lido de vip-content.js pelo id do
 * post, e o id vem de dentro do HMAC que nós mesmos assinamos. Esta função é
 * a segunda tranca — nenhum caminho com `..`, barra inicial, barra invertida
 * ou caractere de controle passa daqui.
 */
function safeObjectPath(source) {
  if (driverName() === 'supabase' && (typeof source !== 'string' || !source.startsWith('ayla/'))) return null;
  if (typeof source !== 'string' || !source || source.length > 300) return null;
  // Cada segmento começa com letra, dígito ou _ — o que barra './x', '../x' e
  // caminho absoluto. Depois valem os caracteres que nomes de arquivo reais
  // usam. Barra invertida e caractere de controle não estão na lista.
  if (!/^[A-Za-z0-9_](?:[A-Za-z0-9 ()._-]|\/(?=[A-Za-z0-9_]))*$/.test(source)) return null;
  if (source.split('/').some((segment) => segment === '.' || segment === '..' || !segment)) return null;
  return source;
}

/* ------------------------------------------------------------ driver local */

/** Pastas privadas permitidas. Fora desta lista, nada é servido. */
function mediaRoots() {
  const configured = process.env.VIP_MEDIA_DIRS || 'Media_Ayla';
  return configured.split(',').map((name) => name.trim()).filter(Boolean);
}

/** Resolve o caminho real no disco, sem deixar escapar da pasta permitida. */
function resolveSource(source) {
  if (!safeObjectPath(source) || !source.includes('/')) return null;

  const [folder, ...rest] = source.split('/');
  if (!mediaRoots().includes(folder)) return null;

  const directory = path.join(ROOT, folder);
  const file = path.resolve(directory, path.basename(rest.join('/')));
  if (!file.startsWith(directory + path.sep)) return null;
  return fs.existsSync(file) ? file : null;
}

/* --------------------------------------------------------- driver supabase */

function supabaseConfig() {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const bucket = (process.env.VIP_MEDIA_BUCKET || '').trim();
  return { url, key, bucket, ok: Boolean(url && key && bucket) };
}

/** 60–300s: tempo de abrir o arquivo, não de compartilhar o link. */
function signedUrlTtl() {
  const configured = Number(process.env.SUPABASE_SIGNED_URL_TTL || 120);
  if (!Number.isFinite(configured)) return 120;
  return Math.min(Math.max(Math.round(configured), 60), 300);
}

/**
 * Pede ao Supabase uma URL assinada para UM objeto.
 *
 * Endpoint do Storage: POST /storage/v1/object/sign/{bucket}/{path}
 * A service role key só existe aqui no servidor — nunca vai para o navegador,
 * nem para o banco, nem para o log.
 */
async function createSupabaseSignedUrl(objectPath) {
  const { url, key, bucket } = supabaseConfig();
  const encoded = objectPath.split('/').map(encodeURIComponent).join('/');

  const response = await fetch(`${url}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encoded}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({ expiresIn: signedUrlTtl() }),
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    // Sem corpo no log: pode conter o caminho e detalhes do bucket.
    throw Object.assign(new Error(`Supabase Storage respondeu ${response.status}`), { status: 502 });
  }

  const data = await response.json().catch(() => null);
  // A API devolve um caminho relativo ('/object/sign/...'); versões do cliente
  // usam signedUrl e outras signedURL. Aceitamos as duas e absolutizamos.
  const signed = data && (data.signedURL || data.signedUrl);
  if (typeof signed !== 'string' || !signed) {
    throw Object.assign(new Error('Supabase Storage não devolveu a URL assinada.'), { status: 502 });
  }

  return /^https?:\/\//i.test(signed) ? signed : `${url}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`;
}

/* ------------------------------------------------------------ configuração */

/**
 * Chamada no boot. Em produção, driver mal configurado derruba o servidor em
 * vez de virar mídia inacessível (ou pior, pública) depois da primeira venda.
 */
function assertConfigured() {
  const driver = driverName();
  if (!['local', 'supabase'].includes(driver)) {
    throw new Error(`VIP_MEDIA_DRIVER inválido: "${driver}". Use 'local' ou 'supabase'.`);
  }

  if (driver === 'supabase') {
    const { url, key, bucket, ok } = supabaseConfig();
    if (!ok) {
      const faltando = [!url && 'SUPABASE_URL', !key && 'SUPABASE_SERVICE_ROLE_KEY', !bucket && 'VIP_MEDIA_BUCKET']
        .filter(Boolean).join(', ');
      throw new Error(`VIP_MEDIA_DRIVER=supabase sem ${faltando}. Sem fallback: o servidor não sobe assim.`);
    }
    if (!/^https:\/\//i.test(url)) throw new Error('SUPABASE_URL precisa ser https.');
  }

  if (driver === 'local' && process.env.NODE_ENV === 'production') {
    console.warn('⚠️  VIP_MEDIA_DRIVER=local em produção: as pastas privadas não vão no deploy '
      + 'e o feed ficará vazio. Use VIP_MEDIA_DRIVER=supabase.');
  }

  // Falha cedo se o segredo do HMAC estiver ausente em produção.
  secret();
  return driver;
}

/**
 * Segredo dos links assinados.
 *
 * Em produção é obrigatório: sem ele os links não sobreviveriam a um restart e,
 * pior, um valor padrão no código seria um segredo público. Em desenvolvimento
 * geramos um aleatório por processo — os links morrem quando o servidor
 * reinicia, o que é chato e seguro, nessa ordem.
 */
let devSecret = null;
function secret() {
  const configured = process.env.VIP_MEDIA_SECRET;
  if (configured && configured.length >= 32) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('VIP_MEDIA_SECRET (32+ caracteres) é obrigatória em produção.');
  }
  if (!devSecret) devSecret = crypto.randomBytes(32).toString('hex');
  return devSecret;
}

const TTL_SECONDS = Number(process.env.VIP_MEDIA_TTL_SECONDS || 900);

/* ------------------------------------------------------------- assinatura */

const b64u = (value) => Buffer.from(value).toString('base64url');

/**
 * Assina o acesso a UM post, para UM pedido, por poucos minutos.
 * O link diz de quem é; quem decide se pode continua sendo o banco.
 */
function signLink(orderId, postId) {
  const body = b64u(JSON.stringify({ o: orderId, p: postId, e: Math.floor(Date.now() / 1000) + TTL_SECONDS }));
  const signature = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyLink(token) {
  if (typeof token !== 'string' || token.length > 512 || !token.includes('.')) return null;
  const [body, signature] = token.split('.');

  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const received = Buffer.from(signature || '', 'utf8');
  const computed = Buffer.from(expected, 'utf8');
  if (received.length !== computed.length || !crypto.timingSafeEqual(received, computed)) return null;

  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { return null; }
  if (!payload || typeof payload.o !== 'string' || payload.e < Math.floor(Date.now() / 1000)) return null;

  return { orderId: payload.o, postId: payload.p };
}

/* ------------------------------------------------------- existência do post */

/**
 * O post entra no feed?
 *
 * local     → o arquivo precisa existir no disco;
 * supabase  → o caminho precisa ser válido. Não damos uma volta na rede por
 *             post a cada montagem do feed; para esconder uma vaga que ainda
 *             não subiu, marque `draft: true` em vip-content.js.
 */
function exists(source) {
  if (driverName() === 'supabase') return Boolean(safeObjectPath(source));
  return Boolean(resolveSource(source));
}

/* ---------------------------------------------------------------- entrega */

const MIME = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif'
};

/** Streaming com Range, para o vídeo poder ser adiantado sem baixar tudo. */
function streamLocal(req, res, source) {
  const file = resolveSource(source);
  if (!file) return res.status(404).json({ error: 'Conteúdo indisponível.' });

  const stat = fs.statSync(file);
  res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Accept-Ranges', 'bytes');

  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match && match[1] ? parseInt(match[1], 10) : 0;
    if (Number.isNaN(start) || start >= stat.size) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }
    const end = Math.min(match && match[2] ? parseInt(match[2], 10) : stat.size - 1, stat.size - 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    return fs.createReadStream(file, { start, end }).pipe(res);
  }

  res.setHeader('Content-Length', stat.size);
  return fs.createReadStream(file).pipe(res);
}

/** Redirect para a signed URL. Nada é proxiado, nada é guardado. */
async function redirectSupabase(req, res, source) {
  const objectPath = safeObjectPath(source);
  if (!objectPath) return res.status(404).json({ error: 'Conteúdo indisponível.' });

  const signedUrl = await createSupabaseSignedUrl(objectPath);

  // 302 e no-store: a URL expira em segundos, nada de cache em CDN nem no navegador.
  res.setHeader('Cache-Control', 'private, no-store');
  return res.redirect(302, signedUrl);
}

async function deliver(req, res, source) {
  if (driverName() === 'supabase') return redirectSupabase(req, res, source);
  return streamLocal(req, res, source);
}

async function removePrivate(source) {
  if (driverName() !== 'supabase' || !safeObjectPath(source) || !source.startsWith('ayla/')) throw new Error('Storage deletion refused');
  const { url, key, bucket } = supabaseConfig();
  if (!url || !key || !bucket) throw new Error('Storage not configured');
  const response = await fetch(`${url}/storage/v1/object/${encodeURIComponent(bucket)}`, {
    method: 'DELETE', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [source] }), signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('Storage deletion failed: ' + response.status);
}
module.exports = {
  removePrivate,
  signLink, verifyLink, deliver, exists, resolveSource, mediaRoots,
  assertConfigured, safeObjectPath, driverName, signedUrlTtl, TTL_SECONDS
};
