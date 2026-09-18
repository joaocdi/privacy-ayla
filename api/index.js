/**
 * Entrada serverless (Vercel).
 *
 * A aplicação continua sendo o MESMO Express de backend/server.js — nada foi
 * reescrito para a Vercel. Aqui só trocamos o `app.listen` (que não existe em
 * serverless) por um handler, garantindo que o banco seja inicializado uma vez
 * por instância antes da primeira requisição.
 *
 * Rodar localmente continua igual: `npm start` dentro de backend/.
 */
// Each Vercel Preview has its own trusted origin. Never derive this from
// an incoming Host header, and never override the Production configuration.
if (process.env.VERCEL_ENV === 'preview') {
  const host = process.env.VERCEL_URL;
  if (!/^[a-z0-9-]+\.vercel\.app$/.test(host || '')) throw new Error('Preview URL unavailable');
  const origin = 'https://' + host;
  process.env.PUBLIC_APP_URL = origin;
  process.env.FRONTEND_URL = origin;
  process.env.ADMIN_ORIGIN = origin;
}
const { app, ready } = require('../backend/server');

// Arquivo estático não precisa de banco. Se algum deles escapar da CDN e cair
// aqui, ele é servido na hora, sem esperar o `ready()` (que conecta no banco).
// Assim uma instância fria nunca segura a primeira pintura da página.
const SEM_BANCO = /\.(?:css|js|jpg|jpeg|png|webp|svg|ico|woff2)$/i;
function estatico(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const rota = String(req.url || '/').split('?')[0];
  if (rota.startsWith('/api/')) return false;
  const PAGINAS = ['/', '/vip', '/criadora/login', '/termos', '/privacidade', '/aviso-de-conteudo', '/contato'];
  return PAGINAS.includes(rota) || SEM_BANCO.test(rota);
}

module.exports = async (req, res) => {
  if (estatico(req)) return app(req, res);
  try {
    await ready();
  } catch (error) {
    console.error('Startup failed:', error.name);
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: 'Serviço indisponível.' }));
  }
  return app(req, res);
};
