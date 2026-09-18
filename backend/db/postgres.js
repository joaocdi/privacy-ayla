/**
 * Driver PostgreSQL — o mesmo contrato do SQLite.
 *
 * Por que existe: na Vercel não há disco persistente, então SQLite em arquivo
 * não serve para produção. Em vez de reescrever services/orders, entitlements,
 * access-tokens e o webhook, este módulo expõe exatamente a mesma interface
 * que eles já usam (`get`, `all`, `run`, `exec`) e traduz o dialeto.
 *
 * Duas compatibilidades importantes, para o resto do código não perceber a troca:
 *  - `run()` devolve { lastID, changes }, como o wrapper do sqlite;
 *  - colunas de data voltam como STRING 'YYYY-MM-DD HH:MM:SS' (UTC), igual ao
 *    SQLite. O server.js faz `expires_at.replace(' ', 'T')` — com objeto Date
 *    isso quebraria em produção e só apareceria no primeiro pedido real.
 */
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// timestamp sem timezone: devolve string, no formato do SQLite (sem fração).
types.setTypeParser(1114, (value) => (value == null ? value : String(value).replace('T', ' ').split('.')[0]));
// date
types.setTypeParser(1082, (value) => value);
// bigint (ids e COUNT): número, como o SQLite devolve. O pg entrega string por
// padrão, o que faria `count === 1` e comparações de id falharem em silêncio.
// Seguro aqui: ids e contagens deste projeto ficam muito abaixo de 2^53.
types.setTypeParser(20, (value) => (value == null ? value : Number(value)));

let pool = null;

function getPool() {
  if (pool) return pool;
  if (process.env.NODE_ENV === 'test' && !/^test_[a-f0-9_]+$/.test(process.env.TEST_DATABASE_SCHEMA || '')) {
    throw new Error('ABORT: PostgreSQL tests require an isolated test_<uuid> schema; public is forbidden.');
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL ausente.');

  // Supabase/Neon exigem TLS; o certificado é da infra do provedor.
  const needsSsl = !/localhost|127\.0\.0\.1|\/\/\/|host=\//.test(connectionString)
    && process.env.PGSSL !== 'disable';

  pool = new Pool({
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : false,
    // Serverless: poucas conexões por instância. Com Supabase, use a porta do
    // pooler (6543) na DATABASE_URL, não a 5432 direta.
    max: Number(process.env.PGPOOL_MAX || (process.env.VERCEL ? 1 : 10)),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000
  });

  const isolatedSchema = require('../creator').databaseSchema();
  if(isolatedSchema) {
    const schema=isolatedSchema;
    // Every pooled request sets a transaction-local path: no public fallback.
    pool.query=async(text,values)=>{
      const client=await pool.connect();
      try{
        await client.query('BEGIN');await client.query(`SET LOCAL search_path TO "${schema}"`);
        const found=await client.query('SELECT current_schema() AS schema');
        if(found.rows[0].schema!==schema)throw new Error('Staging schema unavailable');
        const result=await client.query(text,values);await client.query('COMMIT');return result;
      }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
    };
  }

  pool.on('error', (error) => console.error('Postgres pool error:', error.message));
  return pool;
}

/* ------------------------------------------------------------- tradução SQL */

/**
 * Traduz o SQL do SQLite para Postgres.
 *
 * Não é um tradutor genérico: cobre exatamente as construções usadas neste
 * projeto. Qualquer coisa nova precisa ser adicionada aqui conscientemente —
 * é de propósito, para não dar a impressão de que qualquer SQL funciona.
 */
function translate(sql) {
  let out = String(sql);

  // datetime('now', '+30 minutes') → agora em UTC mais o intervalo
  out = out.replace(/datetime\(\s*'now'\s*,\s*'([^']+)'\s*\)/gi,
    (_, interval) => `((NOW() AT TIME ZONE 'utc') + INTERVAL '${interval}')`);

  // datetime('now') → agora em UTC
  out = out.replace(/datetime\(\s*'now'\s*\)/gi, `(NOW() AT TIME ZONE 'utc')`);

  // datetime(coluna_ou_param, intervalo) → soma de timestamp com intervalo
  out = out.replace(/datetime\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)/gi,
    (_, base, interval) => `(${base}::timestamp + ${interval}::interval)`);

  // CURRENT_TIMESTAMP no Postgres é timestamptz; as colunas são timestamp UTC.
  out = out.replace(/CURRENT_TIMESTAMP/g, `(NOW() AT TIME ZONE 'utc')`);

  // Transação: o Postgres não tem BEGIN IMMEDIATE.
  out = out.replace(/BEGIN\s+IMMEDIATE/gi, 'BEGIN');

  // INSERT OR IGNORE → ON CONFLICT DO NOTHING
  out = out.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');

  out = out.replace(/WHERE\s+0(\s|;|$)/gi, 'WHERE false$1');

  // Placeholders posicionais: ? → $1, $2, ... (ignora ?? e literais não usados aqui)
  let index = 0;
  out = out.replace(/\?/g, () => `$${++index}`);

  // `$4 IS NULL`: o Postgres precisa saber o tipo do parâmetro para decidir.
  // O SQLite não pede nada. Cast para text resolve — só interessa se é nulo.
  out = out.replace(/(\$\d+)\s+IS\s+(NOT\s+)?NULL/gi,
    (_, param, not) => `${param}::text IS ${not ? 'NOT ' : ''}NULL`);

  return out;
}

/** O wrapper `sqlite` aceita params soltos ou um array. Normaliza. */
function normalizeParams(params) {
  if (params.length === 1 && Array.isArray(params[0])) return params[0];
  return params;
}

/** INSERT sem RETURNING não devolve o id; acrescentamos para manter lastID. */
function withReturningId(sql) {
  const trimmed = sql.trim().replace(/;$/, '');
  if (!/^insert\s/i.test(trimmed)) return { sql: trimmed, added: false };
  if (/\breturning\b/i.test(trimmed)) return { sql: trimmed, added: false };
  if(/^insert\s+into\s+buyer_accounts\b/i.test(trimmed))return {sql:`${trimmed} RETURNING user_id AS id`,added:false};
  // Tabelas cuja chave não se chama `id`: pedir RETURNING id derruba a
  // transação inteira no PostgreSQL ("column id does not exist").
  if (/^insert\s+into\s+(media_deletions|admin_users|entitlement_duplicates_archive)\b/i.test(trimmed)) return { sql: trimmed, added: false };
  return { sql: `${trimmed} RETURNING id`, added: true };
}

function wrap(executor) {
  return {
    async get(sql, ...params) {
      const result = await executor(translate(sql), normalizeParams(params));
      return result.rows[0];
    },
    async all(sql, ...params) {
      const result = await executor(translate(sql), normalizeParams(params));
      return result.rows;
    },
    async run(sql, ...params) {
      const prepared = withReturningId(translate(sql));
      let result;
      try {
        result = await executor(prepared.sql, normalizeParams(params));
      } catch (error) {
        // Tabela sem coluna id (não é o caso hoje, mas não vale quebrar por isso).
        if (prepared.added && error.code === '42703') {
          result = await executor(translate(sql), normalizeParams(params));
        } else {
          throw error;
        }
      }
      return {
        lastID: result.rows && result.rows[0] ? result.rows[0].id : undefined,
        changes: result.rowCount
      };
    },
    async exec(sql) {
      await executor(translate(sql), []);
    },
    async close() { /* conexões voltam ao pool sozinhas */ }
  };
}

/* ------------------------------------------------------------------- API */

let dbPromise = null;

function getDb() {
  if (!dbPromise) {
    const client = wrap((text, values) => getPool().query(text, values));
    dbPromise = Promise.resolve(client);
  }
  return dbPromise;
}

async function initDb() {
  const schema = fs.readFileSync(path.resolve(__dirname, 'schema.postgres.sql'), 'utf8');
  await getPool().query(schema);
  await getPool().query(fs.readFileSync(path.join(__dirname, 'schema.buyer.sql'), 'utf8'));
  for (const table of ['buyer_recovery', 'buyer_recovery_limits', 'buyer_sessions']) {
    await getPool().query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  }
  await getPool().query(fs.readFileSync(path.join(__dirname, 'schema.content.sql'), 'utf8'));
  await require('./content-migrations').migrate(await getDb(), true);
  // Additive: databases created before the HOME preview feature keep their rows.
  await getPool().query('ALTER TABLE vip_posts ADD COLUMN IF NOT EXISTS show_as_preview INTEGER NOT NULL DEFAULT 0');
  await getPool().query('ALTER TABLE vip_posts ADD COLUMN IF NOT EXISTS preview_image TEXT');
  await getPool().query('ALTER TABLE vip_posts ADD COLUMN IF NOT EXISTS likes_count INTEGER NOT NULL DEFAULT 0');
  await getPool().query('CREATE INDEX IF NOT EXISTS vip_posts_preview_idx ON vip_posts(creator_id,published,archived,show_as_preview,sort_order)');
  // Depois das colunas existirem: a mídia única de cada post vira o item 1.
  await require('./content-migrations').backfillMedia(await getDb());
  // No public Data API access: all content/admin operations go through our backend.
  for (const table of ['push_subscriptions','analytics_events', 'conversion_events', 'media_deletions', 'creator_profiles', 'vip_posts', 'vip_post_media', 'vip_content_settings', 'vip_post_likes', 'admin_sessions', 'admin_login_limits', 'vip_uploads', 'admin_users',
    // Tabelas só do backend: o dono (backend) ignora RLS; anon/authenticated ficam sem acesso.
    'orders', 'entitlements', 'access_tokens', 'entitlement_duplicates_archive']) {
    await getPool().query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  }
  await require('./grant-migrations').migrate(await getDb(), true);
  await require('./account-migrations').migrate(await getDb(), true);
  return getDb();
}

/**
 * Transação com uma conexão dedicada — nenhuma outra requisição entra no meio.
 * Mesma assinatura da versão SQLite.
 */
async function transaction(work) {
  const client = await getPool().connect();
  const db = wrap((text, values) => client.query(text, values));
  try {
    await client.query('BEGIN');
    const isolatedSchema = require('../creator').databaseSchema();
    if(isolatedSchema){
      const schema=isolatedSchema;
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      const found=await client.query('SELECT current_schema() AS schema');
      if(found.rows[0].schema!==schema)throw new Error('Staging schema unavailable');
    }
    const result = await work(db);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function closeDb() {
  dbPromise = null;
  if (pool) {
    const current = pool;
    pool = null;
    await current.end();
  }
}

module.exports = { getDb, initDb, transaction, closeDb, translate };
