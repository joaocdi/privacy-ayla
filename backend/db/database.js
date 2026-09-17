const path = require('path');
const fs = require('fs');

/**
 * O SQLite é carregado só quando é ele o driver escolhido.
 *
 * Em produção (Postgres) o sqlite3 é um módulo nativo que não faz falta: exigi-lo
 * no topo faria o build da Vercel quebrar — ou carregar um binário inútil — por
 * causa de uma dependência que aquele ambiente nunca usa.
 */
function sqliteDriver() {
  return { sqlite3: require('sqlite3'), open: require('sqlite').open };
}

/* Conexão única (singleton): antes cada chamada abria um novo handle do SQLite
   e nunca fechava, vazando descritores de arquivo. */
let dbPromise = null;

function getDb() {
  if (!dbPromise) {
    const dbPath = process.env.DATABASE_PATH || path.resolve(__dirname, 'database.sqlite');

    const { sqlite3, open } = sqliteDriver();
    dbPromise = open({
      filename: dbPath,
      driver: sqlite3.Database
    }).then(async (db) => {
      await db.exec('PRAGMA journal_mode = WAL;');
      await db.exec('PRAGMA foreign_keys = ON;');
      await db.exec('PRAGMA busy_timeout = 10000;');
      return db;
    }).catch((err) => {
      dbPromise = null; // permite nova tentativa se a abertura falhar
      throw err;
    });
  }

  return dbPromise;
}

async function initDb() {
  const db = await getDb();
  const schemaPath = path.resolve(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  // Execute the schema to create tables if they don't exist
  await db.exec(schema);
  await db.exec(fs.readFileSync(path.join(__dirname, 'schema.buyer.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(__dirname, 'schema.content.sql'), 'utf8'));
  await require('./content-migrations').migrate(db);
  // Additive: databases created before the HOME preview feature keep their rows.
  const contentColumns = new Set((await db.all('PRAGMA table_info(vip_posts)')).map(c => c.name));
  for (const [name, type] of Object.entries({ show_as_preview: 'INTEGER NOT NULL DEFAULT 0', preview_image: 'TEXT', likes_count: 'INTEGER NOT NULL DEFAULT 0' })) {
    if (!contentColumns.has(name)) await db.exec(`ALTER TABLE vip_posts ADD COLUMN ${name} ${type}`);
  }
  await db.exec('CREATE INDEX IF NOT EXISTS vip_posts_preview_idx ON vip_posts(creator_id,published,archived,show_as_preview,sort_order)');
  // Depois das colunas existirem: a mídia única de cada post vira o item 1.
  await require('./content-migrations').backfillMedia(db);
  const columns = new Set((await db.all('PRAGMA table_info(orders)')).map(c => c.name));
  const additions = {
    checkout_hash: 'TEXT', pix_qr_code: 'TEXT', webhook_token_hash: 'TEXT',
    access_days: 'INTEGER', access_type: "TEXT DEFAULT 'vip'",
    customer_name: 'TEXT', customer_email: 'TEXT', customer_phone: 'TEXT',
    customer_document_hash: 'TEXT', customer_document_last3: 'TEXT'
  };
  for (const [name, type] of Object.entries(additions)) {
    if (!columns.has(name)) await db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${type}`);
  }
  // Preserve old expired duplicate fixtures/history before enforcing uniqueness.
  // Conflicting active grants are not merged automatically.
  await db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS entitlement_duplicates_archive AS
      SELECT *, CURRENT_TIMESTAMP AS archived_at FROM entitlements WHERE 0;
    INSERT INTO entitlement_duplicates_archive (id,order_id,telegram_user_id,product_id,starts_at,expires_at,status,created_at,archived_at)
      SELECT e.id,e.order_id,e.telegram_user_id,e.product_id,e.starts_at,e.expires_at,e.status,e.created_at,CURRENT_TIMESTAMP FROM entitlements e
      WHERE e.status='EXPIRED' AND EXISTS (
        SELECT 1 FROM entitlements keep WHERE keep.order_id=e.order_id AND keep.status='ACTIVE');
    DELETE FROM entitlements WHERE id IN (SELECT id FROM entitlement_duplicates_archive);
    COMMIT;`);
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS entitlement_order_unique ON entitlements(order_id);
    CREATE UNIQUE INDEX IF NOT EXISTS webhook_token_unique ON orders(webhook_token_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS checkout_hash_unique ON orders(checkout_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS provider_payment_unique ON orders(payment_provider, provider_payment_id);`);
  await require('./grant-migrations').migrate(db);
  await require('./account-migrations').migrate(db);
  return db;
}

// A dedicated connection prevents unrelated requests from joining a transaction.
let transactionQueue = Promise.resolve();
function transaction(work) {
  const pending = transactionQueue.then(() => runTransaction(work));
  transactionQueue = pending.catch(() => {});
  return pending;
}
async function runTransaction(work) {
  const { sqlite3, open } = sqliteDriver();
  const db = await open({ filename: process.env.DATABASE_PATH || path.resolve(__dirname, 'database.sqlite'), driver: sqlite3.Database });
  try {
    await db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000; BEGIN IMMEDIATE;');
    const result = await work(db);
    await db.exec('COMMIT;');
    return result;
  } catch (error) {
    await db.exec('ROLLBACK;').catch(() => {});
    throw error;
  } finally { await db.close(); }
}

async function closeDb() {
  if (dbPromise) await (await dbPromise).close();
  dbPromise = null;
}

/**
 * SELEÇÃO DO BANCO — por ambiente, nunca por edição de código.
 *
 *   DATABASE_URL definida  → PostgreSQL (produção: Supabase/Vercel)
 *   DATABASE_URL ausente   → SQLite local (desenvolvimento e testes)
 *
 * Em produção o SQLite é recusado no boot: na Vercel o disco é efêmero, então
 * um "banco" em arquivo perderia pedidos pagos a cada deploy — falha silenciosa
 * e cara. Melhor não subir.
 */
const databaseUrl = (process.env.DATABASE_URL || '').trim();
const usePostgres = /^postgres(ql)?:\/\//i.test(databaseUrl);

if (!usePostgres && process.env.NODE_ENV === 'production') {
  throw new Error(
    'DATABASE_URL (PostgreSQL) é obrigatória em produção. SQLite em arquivo não persiste na Vercel.'
  );
}

module.exports = usePostgres
  ? { ...require('./postgres'), driver: 'postgres' }
  : { getDb, initDb, transaction, closeDb, driver: 'sqlite' };
