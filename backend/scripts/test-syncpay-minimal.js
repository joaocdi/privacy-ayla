'use strict';

/**
 * Diagnóstico isolado da API Partner SyncPay.
 *
 * Não importa server, repositories, orders ou entitlements. A única escrita
 * externa possível é a criação de uma cobrança PIX pendente de R$ 9,90.
 * O script não paga, não consulta e não salva essa cobrança.
 */
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const BASE_URL = 'https://api.syncpayments.com.br/api/partner/v1';
const TIMEOUT_MS = 20_000;

function redact(value, key = '') {
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  }
  // Mantém nomes de campos e mensagens de validação; remove credenciais e o
  // BR Code pagável caso a cobrança seja aceita.
  if (/(^token$|identifier|access[_-]?token|authorization|client[_-]?(id|secret)|pix[_-]?(code|copy|qr)|qr[_-]?code)/i.test(key)) {
    return value == null ? value : '[REDACTED]';
  }
  return value;
}

async function post(route, body, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(BASE_URL + route, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const raw = await response.text();
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : null; }
    catch (_) { parsed = raw ? { nonJsonResponse: true, length: raw.length } : null; }
    return { status: response.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const clientId = process.env.SYNCPAY_CLIENT_ID;
  const clientSecret = process.env.SYNCPAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Configure SYNCPAY_CLIENT_ID e SYNCPAY_CLIENT_SECRET em backend/.env.');
  }

  const auth = await post('/auth-token', {
    client_id: clientId,
    client_secret: clientSecret
  });
  console.log('AUTH HTTP:', auth.status);
  console.log('AUTH BODY:', JSON.stringify(redact(auth.body), null, 2));

  const accessToken = auth.body?.access_token ?? auth.body?.data?.access_token;
  if (!accessToken || auth.status < 200 || auth.status >= 300) {
    throw new Error('A autenticação não retornou um access_token; nenhuma cobrança foi criada.');
  }

  // Teste mínimo solicitado: somente o valor, sem client e sem qualquer dado
  // inventado de comprador. Não há retry para evitar cobranças duplicadas.
  const cashIn = await post('/cash-in', { amount: 9.90 }, accessToken);
  console.log('PIX HTTP:', cashIn.status);
  console.log('PIX BODY:', JSON.stringify(redact(cashIn.body), null, 2));
}

main().catch(error => {
  const message = error?.name === 'AbortError'
    ? 'A SyncPay não respondeu dentro de 20 segundos.'
    : error.message;
  console.error('ERRO:', message);
  process.exitCode = 1;
});
