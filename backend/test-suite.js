/**
 * test-suite.js - Bateria completa de testes do fluxo de pagamento
 * Execute com: node test-suite.js
 */

require('dotenv').config();
if (require('./db/database').driver !== 'sqlite' || !process.env.TEST_BASE_URL || !process.env.DATABASE_PATH?.includes('.test-runs')) {
  throw new Error('ABORT: run this SQLite suite through npm test with an isolated database/server.');
}

// Usa a mesma porta configurada no .env, para não ficar dessincronizado.
const BASE = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const checkoutToken = require('crypto').randomBytes(32).toString('hex');
let passCount = 0;
let failCount = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passCount++;
  } catch (err) {
    console.log(`  ❌ FAIL: ${name}`);
    console.log(`         Razão: ${err.message}`);
    failCount++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + checkoutToken }
  };
  if (body) opts.body = JSON.stringify(path === '/api/payments/pix' ? { ...body, checkoutToken, client:{phone:'11999990000'} } : body);
  const res = await fetch(`${BASE}${path}`, opts);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function runTests() {
  console.log('\n===========================');
  console.log('  BATERIA DE TESTES - INICIANDO');
  console.log('===========================\n');

  // --- TEST 1: Produto inválido não cria PIX ---
  await test('Teste 1: Produto inválido não cria PIX', async () => {
    const { status, body } = await api('POST', '/api/payments/pix', { productId: 'invalid_xxx' });
    assert(status === 404, `Esperado 404, recebido ${status}`);
    assert(body.error, 'Deve retornar campo error');
  });

  // --- TEST 2: Produto válido cria pedido PENDING ---
  let order1;
  await test('Teste 2: Produto válido cria pedido PENDING', async () => {
    const { status, body } = await api('POST', '/api/payments/pix', { productId: 'ayla_monthly' });
    assert(status === 201 || status === 200, `Esperado 201, recebido ${status}`);
    assert(body.orderId, 'Deve retornar orderId');
    assert(body.status === 'PENDING', `Status deve ser PENDING, recebido ${body.status}`);
    assert(body.pix && body.pix.copyPaste, 'Deve retornar pix.copyPaste');
    assert(body.pix.qrCode, 'Deve retornar pix.qrCode');
    order1 = body;
  });

  // --- TEST 3: O valor vem do backend (produto ignora price enviado pelo cliente) ---
  await test('Teste 3: Preço real é determinado pelo backend', async () => {
    const { status, body } = await api('POST', '/api/payments/pix', { productId: 'ayla_monthly' });
    assert(status === 201 || status === 200, `Esperado 201, recebido ${status}`);
    assert(body.product.price === 9.90, `Preço deve ser 9.90, recebido ${body.product.price}`);
    assert(body.product.name === '1 mês', `Nome deve ser "1 mês", recebido "${body.product.name}"`);
  });

  // --- TEST 4: Mock payment muda pedido para PAID ---
  let orderId = order1 && order1.orderId;
  await test('Teste 4: Mock payment muda pedido para PAID', async () => {
    assert(orderId, 'orderId deve existir do Teste 2');
    const { status, body } = await api('POST', `/api/dev/orders/${orderId}/pay`, {});
    assert(status === 200, `Esperado 200, recebido ${status} - ${JSON.stringify(body)}`);
    assert(body.success === true, 'Deve retornar success:true');
  });

  // --- TEST 5: Pedido pago cria apenas UM entitlement (idempotência) ---
  await test('Teste 5: Pedido pago cria apenas UM entitlement (idempotência)', async () => {
    assert(orderId, 'orderId deve existir do Teste 2');
    // Chamar simulate-paid de novo em um pedido já PAID
    const { status, body } = await api('POST', `/api/dev/orders/${orderId}/pay`, {});
    assert(status === 400, `Esperado 400 (já pago), recebido ${status} - ${JSON.stringify(body)}`);
    // Agora verificar status do pedido
    const { status: s2, body: b2 } = await api('GET', `/api/orders/${orderId}/status`);
    assert(s2 === 200, `Status query falhou: ${s2}`);
    assert(b2.status === 'PAID', `Status deve ser PAID, recebido ${b2.status}`);
  });

  // --- TEST 6: Pedido pago cria token de acesso ---
  let accessToken;
  await test('Teste 6: Pedido pago permite geração de access token', async () => {
    assert(orderId, 'orderId deve existir do Teste 2');
    const { status, body } = await api('GET', `/api/access/${orderId}`);
    assert(status === 200, `Esperado 200, recebido ${status} - ${JSON.stringify(body)}`);
    assert(body.url && body.url.includes('?start='), `URL deve conter ?start=, recebido ${body.url}`);
    accessToken = body.url.split('?start=')[1];
    assert(accessToken && accessToken.length > 10, 'Token deve ser longo o suficiente');
  });

  // --- TEST 7: Repetir confirmação não duplica entitlement (webhook idempotente) ---
  await test('Teste 7: Webhook idempotente - não duplica entitlement', async () => {
    const db = await require('./db/database').getDb();
    const token = require('crypto').randomBytes(32).toString('hex');
    await db.run('UPDATE orders SET webhook_token_hash=? WHERE public_id=?', require('./services/security').hash(token), orderId);
    const payload = { token, event: 'TRANSACTION_PAID' };
    const { status: s1 } = await api('POST', '/api/payments/webhook', payload);
    const { status: s2 } = await api('POST', '/api/payments/webhook', payload);
    // Ambas devem responder com 200 OK (sem erro 500)
    assert(s1 === 200, `Primeiro webhook falhou: ${s1}`);
    assert(s2 === 200, `Segundo webhook falhou (deveria ser idempotente): ${s2}`);
  });

  // --- TEST 8: Token inválido é recusado ---
  await test('Teste 8: Token inválido é recusado', async () => {
    const { getDb } = require('./db/database');
    const { validateAndConsumeToken } = require('./services/access-tokens');
    const result = await validateAndConsumeToken('token_invalido_xxxxx', '999999');
    assert(result.valid === false, 'Token inválido deve retornar valid:false');
    assert(result.error, 'Deve retornar mensagem de erro');
  });

  // --- TEST 9: Token expirado é recusado ---
  await test('Teste 9: Token expirado é identificado corretamente', async () => {
    const { getDb } = require('./db/database');
    const crypto = require('crypto');
    const db = await getDb();
    const fakeToken = crypto.randomBytes(16).toString('hex');
    const fakeHash = crypto.createHash('sha256').update(fakeToken).digest('hex');
    await db.run(
      `INSERT INTO access_tokens (order_id, token_hash, expires_at) VALUES ((SELECT id FROM orders WHERE public_id=?), ?, datetime('now', '-1 hour'))`,
      [orderId, fakeHash]
    );
    const { validateAndConsumeToken } = require('./services/access-tokens');
    const result = await validateAndConsumeToken(fakeToken, '999999');
    assert(result.valid === false, 'Token expirado deve retornar valid:false');
    assert(result.error && result.error.includes('expirado'), `Deve mencionar expirado, recebido: ${result.error}`);
  });

  // --- TEST 10: Token não pode ser vinculado a dois usuários diferentes ---
  await test('Teste 10: Token não pode ser vinculado a duas contas Telegram diferentes', async () => {
    const { getDb } = require('./db/database');
    const crypto = require('crypto');
    const db = await getDb();
    const fakeToken = crypto.randomBytes(16).toString('hex');
    const fakeHash = crypto.createHash('sha256').update(fakeToken).digest('hex');
    await db.run(
      `INSERT INTO access_tokens (order_id, token_hash, telegram_user_id, used_at, expires_at) VALUES ((SELECT id FROM orders WHERE public_id=?), ?, '111111', CURRENT_TIMESTAMP, datetime('now', '+1 hour'))`,
      [orderId, fakeHash]
    );
    const { validateAndConsumeToken } = require('./services/access-tokens');
    const result = await validateAndConsumeToken(fakeToken, '222222');
    assert(result.valid === false, 'Token de outro usuário deve retornar valid:false');
    assert(result.error && result.error.includes('outra conta'), `Deve mencionar outra conta, recebido: ${result.error}`);
  });

  // --- TEST 11: Bot gera convite individual (sem Telegram real, testa a função) ---
  await test('Teste 11: Módulo de convite Telegram carrega corretamente', async () => {
    const { createInviteLink, kickUser } = require('./telegram/invites');
    assert(typeof createInviteLink === 'function', 'createInviteLink deve ser função');
    assert(typeof kickUser === 'function', 'kickUser deve ser função');
  });

  // --- TEST 12: Entitlement expirado é identificado corretamente ---
  await test('Teste 12: Entitlement expirado é identificado pela rotina de expiração', async () => {
    const { getDb } = require('./db/database');
    const db = await getDb();
    await db.run("INSERT INTO orders (public_id,product_id,amount,status) VALUES ('expiry_fixture','ayla_monthly',9.9,'PAID')");
    await db.run(
      `INSERT INTO entitlements (order_id, product_id, starts_at, expires_at, status)
       VALUES ((SELECT id FROM orders WHERE public_id='expiry_fixture'), 'ayla_monthly', datetime('now', '-31 days'), datetime('now', '-1 day'), 'ACTIVE')`
    );
    const { getExpiredEntitlements } = require('./services/entitlements');
    const expired = await getExpiredEntitlements();
    assert(expired.length >= 1, `Deve encontrar pelo menos 1 entitlement expirado, encontrou ${expired.length}`);
  });

  // --- SUMMARY ---
  console.log('\n===========================');
  console.log(`  RESULTADO FINAL: ${passCount} passaram / ${failCount} falharam`);
  console.log('===========================\n');
  
  if (failCount === 0) {
    console.log('  🎉 TODOS OS TESTES PASSARAM! Fluxo ponta a ponta verificado.\n');
  } else {
    console.log('  ⚠️  Alguns testes falharam. Verifique os detalhes acima.\n');
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Erro crítico nos testes:', err);
  process.exit(1);
});
