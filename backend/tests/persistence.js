/**
 * Seleção da persistência e do provider por ambiente.
 *
 * Roda cada cenário num processo separado, porque as duas escolhas acontecem
 * no carregamento do módulo — é justamente isso que precisa ser verificado.
 */
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');

function run(code, env) {
  return spawnSync(process.execPath, ['-e', code], {
    cwd: root,
    // Um ambiente limpo: nada do .env local pode mascarar o cenário testado.
    env: { PATH: process.env.PATH, DOTENV_CONFIG_QUIET: 'true', ...env },
    encoding: 'utf8'
  });
}

const PG_URL = 'postgresql://user:pass@db.example.com:6543/postgres';

// 1. Sem DATABASE_URL, em desenvolvimento: SQLite.
{
  const result = run("process.stdout.write(require('./db/database').driver)", { NODE_ENV: 'development' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'sqlite');
}

// 2. Com DATABASE_URL: Postgres, sem tocar em código.
{
  const result = run("process.stdout.write(require('./db/database').driver)", { DATABASE_URL: PG_URL });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'postgres');
}

// 3. Produção sem DATABASE_URL: o servidor NÃO sobe.
//    SQLite em arquivo na Vercel perderia pedidos pagos a cada deploy.
{
  const result = run("require('./db/database')", { NODE_ENV: 'production' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_URL/);
}

// 4. Produção com Postgres e SigiloPay: carrega.
{
  const result = run(
    "process.stdout.write(require('./db/database').driver + ':' + require('./payments/provider').name)",
    { NODE_ENV: 'production', DATABASE_URL: PG_URL, PAYMENT_PROVIDER: 'sigilopay' }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'postgres:sigilopay');
}

// 5. Produção com provider mock: o mock nunca carrega; só o checkout fica indisponível.
{
  const result = run("const p=require('./payments/provider');if(p.name!=='unavailable'||Object.keys(require.cache).some(k=>/mock-provider/.test(k)))process.exit(3);p.createPixPayment({}).then(()=>process.exit(4),e=>process.exit(e.status===503?0:5))", {
    NODE_ENV: 'production', DATABASE_URL: PG_URL, PAYMENT_PROVIDER: 'mock'
  });
  assert.equal(result.status, 0, result.stderr);
}

// 6. Callback derivado de PUBLIC_APP_URL, sem localhost nem domínio fixo.
{
  const result = run(
    "process.stdout.write(require('./payments/sigilopay-provider').configuration().callbackUrl)",
    {
      NODE_ENV: 'production', DATABASE_URL: PG_URL, PAYMENT_PROVIDER: 'sigilopay',
      SIGILOPAY_PUBLIC_KEY: 'k', SIGILOPAY_SECRET_KEY: 's',
      PUBLIC_APP_URL: 'https://ayla.example.com/'
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'https://ayla.example.com/api/payments/webhook');
}

// 7. Callback http:// é recusado — webhook de pagamento só em HTTPS.
{
  const result = run("require('./payments/sigilopay-provider').configuration()", {
    NODE_ENV: 'production', DATABASE_URL: PG_URL, PAYMENT_PROVIDER: 'sigilopay',
    SIGILOPAY_PUBLIC_KEY: 'k', SIGILOPAY_SECRET_KEY: 's',
    PUBLIC_APP_URL: 'http://ayla.example.com'
  });
  assert.notEqual(result.status, 0);
}

// 8. A tradução de SQL cobre o que o projeto realmente usa.
{
  const { translate } = require('../db/postgres');
  assert.match(translate("datetime('now', '+30 minutes')"), /INTERVAL '\+30 minutes'/);
  assert.match(translate('WHERE expires_at > CURRENT_TIMESTAMP'), /NOW\(\) AT TIME ZONE 'utc'/);
  assert.equal(translate('SELECT * FROM orders WHERE a=? AND b=?'),
    'SELECT * FROM orders WHERE a=$1 AND b=$2');
  assert.match(translate('BEGIN IMMEDIATE;'), /^BEGIN;/);
}

console.log('PASS: seleção sqlite/postgres, trava de produção, provider por env, callback derivado, tradução SQL');
