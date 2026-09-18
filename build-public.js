/**
 * Casca estática na CDN.
 *
 * Todo pedido caía na função serverless, e a função espera `ready()` — que
 * abre o banco antes de responder QUALQUER coisa, inclusive o index.html. Em
 * instância fria isso é o atraso que aparece como "a tela 18+ demora".
 *
 * Copiando a casca pública para `public/`, a Vercel entrega HTML, CSS, JS e
 * imagens direto da CDN: a função só é acionada para /api e para as páginas
 * que realmente dependem de sessão. Entra aqui só o que JÁ era público em
 * backend/server.js (mesma allowlist) — nada de backend, banco ou mídia
 * privada.
 */
const fs = require('node:fs');
const path = require('node:path');

const CASCA = [
  'index.html', 'vip.html', 'login.html', 'legal.html',
  'style.css', 'app.js', 'fonts.css', 'image-tools.js',
  'frame.js', 'frame.css', 'carousel.js', 'carousel.css',
  'tips.js', 'tips.css', 'vip.js', 'vip.css',
  'login.js', 'login.css', 'buyer-account.js', 'buyer-account.css',
  'admin-loader.js', 'admin-mode.js', 'admin-mode.css', 'pending-checkouts.js', 'pix-notification.js',
  'analytics.js', 'push.js', 'push-sw.js', 'continue.html', 'continue.js',
  'avatar.jpg', 'cover.jpg', 'favicon.ico', 'og.jpg',
];

const OUT = 'public';
fs.mkdirSync(OUT, { recursive: true });

const copiados = [];
const selo = fs.readdirSync('.').filter(nome => /^verified-[a-z]+\.png$/.test(nome));
for (const nome of CASCA.concat(selo)) {
  if (!fs.existsSync(nome)) continue;
  fs.copyFileSync(nome, path.join(OUT, nome));
  copiados.push(nome);
}
if (fs.existsSync('previews')) fs.cpSync('previews', path.join(OUT, 'previews'), { recursive: true });
fs.cpSync('fonts', path.join(OUT, 'fonts'), { recursive: true });

console.log('casca estática: ' + copiados.length + ' arquivo(s) + fontes em public/');
