/**
 * Diagnóstico isolado. Cria até quatro cobranças NÃO PAGAS no gateway.
 * Não importa app/provider/repository, não inicia servidor nem grava pedidos.
 * Execute: node backend/scripts/test-sigilopay-minimal.js
 * Use --all para testar A/B/C/D independentemente de erro de validação em A.
 * Dados reais autorizados em backend/.env:
 * SIGILOPAY_TEST_NAME, SIGILOPAY_TEST_EMAIL, SIGILOPAY_TEST_PHONE
 * Credenciais/base/callback: mesmas variáveis da integração existente.
 * SIGILOPAY_TEST_AMOUNT opcional (padrão R$ 9,90).
 * Saída JSON: corpo da resposta, com credenciais/tokens de webhook ocultados.
 * Sem retry automático: timeout pode significar cobrança criada no gateway.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dotenv = require('dotenv');

const variants = [
  { test: 1, fields: ['name', 'email', 'phone'] },
  { test: 2, fields: ['name', 'phone'] },
  { test: 3, fields: ['phone'] },
  { test: 4, fields: [] }
];
function configuration(env) {
  const required = ['SIGILOPAY_PUBLIC_KEY', 'SIGILOPAY_SECRET_KEY', 'SIGILOPAY_TEST_NAME', 'SIGILOPAY_TEST_EMAIL', 'SIGILOPAY_TEST_PHONE'];
  const missing = required.filter(key => !env[key]?.trim());
  const callback = env.SIGILOPAY_CALLBACK_URL || (env.PUBLIC_APP_URL ? env.PUBLIC_APP_URL.replace(/\/+$/, '') + '/api/payments/webhook' : '');
  if (!callback) missing.push('PUBLIC_APP_URL ou SIGILOPAY_CALLBACK_URL');
  if (missing.length) throw new Error('Configuração ausente no backend/.env: ' + missing.join(', '));
  const base = new URL(env.SIGILOPAY_BASE_URL || 'https://app.sigilopay.com.br/api/v1');
  const callbackUrl = new URL(callback);
  for (const url of [base, callbackUrl]) {
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Base/callback precisam ser URLs HTTPS simples, sem credenciais ou parâmetros.');
  }
  if (callbackUrl.pathname !== '/api/payments/webhook') throw new Error('Callback precisa terminar em /api/payments/webhook.');
  const amount = Number(env.SIGILOPAY_TEST_AMOUNT || '9.90');
  if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100) throw new Error('SIGILOPAY_TEST_AMOUNT inválido (reais, até duas casas decimais).');
  const client = { name: env.SIGILOPAY_TEST_NAME.trim(), email: env.SIGILOPAY_TEST_EMAIL.trim(), phone: env.SIGILOPAY_TEST_PHONE.trim() };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(client.email) || !/^[+\d()\s-]{10,25}$/.test(client.phone)) throw new Error('Verifique o formato do e-mail e telefone autorizados.');
  return { endpoint: base.href.replace(/\/+$/, '') + '/gateway/pix/receive', callbackUrl: callbackUrl.href, amount, client,
    publicKey: env.SIGILOPAY_PUBLIC_KEY, secretKey: env.SIGILOPAY_SECRET_KEY };
}
function redact(value, config) {
  const clean = text => [config.secretKey, config.publicKey].filter(Boolean).reduce((result, secret) => result.split(secret).join('[REDACTED]'), String(text));
  if (Array.isArray(value)) return value.map(item => redact(item, config));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [clean(key), /^(webhookToken|token|secret|secretKey|publicKey|authorization|x-secret-key|x-public-key)$/i.test(key) ? '[REDACTED]' : redact(item, config)]));
  return typeof value === 'string' ? clean(value) : value;
}
async function diagnose(config, fetchImpl = fetch, emit = value => console.log(JSON.stringify(value, null, 2)), options = {}) {
  const results = [];
  for (const variant of variants) {
    if (!options.all && variant.test > 1 && !results[0].accepted) {
      const skipped = { test: variant.test, fields: variant.fields, document: false, http: null, result: 'Não executado: teste 1 não confirmou criação.' };
      results.push(skipped); emit(skipped); continue;
    }
    const identifier = 'diag_sigilopay_' + Date.now() + '_' + crypto.randomBytes(10).toString('hex');
    const body = { identifier, amount: config.amount, callbackUrl: config.callbackUrl };
    if (variant.fields.length) body.client = Object.fromEntries(variant.fields.map(key => [key, config.client[key]]));
    let response;
    try {
      response = await fetchImpl(config.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json', 'x-public-key': config.publicKey, 'x-secret-key': config.secretKey }, body: JSON.stringify(body) });
      const text = await response.text();
      let payload; try { payload = JSON.parse(text); } catch (_) { payload = text; }
      const accepted = response.ok && Boolean(payload?.transactionId) && typeof payload?.pix?.code === 'string' && payload.pix.code.length > 0;
      const result = { test: variant.test, identifier, amount: config.amount, fields: variant.fields, document: false,
        http: response.status, accepted, transactionId: payload?.transactionId || null,
        result: accepted ? 'Cobrança criada; NÃO paga.' : 'Criação não confirmada. Consulte a resposta; não inferir campo obrigatório só pelo status.',
        body: redact(payload, config) };
      const sanitized = redact(result, config);
      results.push(sanitized); emit(sanitized);
    } catch (_) {
      // Do not emit raw errors: an upstream error may contain request credentials.
      const uncertain = { test: variant.test, identifier, fields: variant.fields, document: false, http: response?.status || null,
        accepted: false, result: 'Resposta incompleta, timeout ou falha de transporte. Criação indeterminada; sem retry. Confira o identifier no gateway antes de repetir.' };
      results.push(uncertain); emit(uncertain); break;
    }
  }
  return results;
}
if (require.main === module) {
  // Parse only this file: never inherit credentials from the shell or mutate env.
  try {
    const env = dotenv.parse(fs.readFileSync(path.resolve(__dirname, '../.env')));
    const config = configuration(env);
    // Explicit --all runs the four independent probes even after a validation error.
    // Transport uncertainty still stops the run without retries.
    diagnose(config, fetch, undefined, { all: process.argv.includes('--all') }).catch(() => { console.error('Diagnóstico interrompido; verifique cobranças de diagnóstico antes de repetir.'); process.exitCode = 1; });
  } catch (error) {
    // Configuration messages contain variable names only, never their values.
    console.error(error.code === 'ENOENT' ? 'backend/.env não encontrado.' : error instanceof TypeError ? 'URL inválida na configuração.' : error.message);
    process.exitCode = 1;
  }
}
module.exports = { configuration, diagnose, redact };
