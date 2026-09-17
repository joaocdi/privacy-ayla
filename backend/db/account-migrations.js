async function migrate(db, postgres = false) {
  const columns = postgres ? null : new Set((await db.all('PRAGMA table_info(orders)')).map(c=>c.name));
  for(const [name,type] of Object.entries({purchase_kind:"TEXT NOT NULL DEFAULT 'access' CHECK(purchase_kind IN ('access','tip'))",buyer_id:'TEXT',purchase_buyer_id:'TEXT',claim_required:'INTEGER NOT NULL DEFAULT 0',claim_token_hash:'TEXT',claimed_at:'TIMESTAMP',creation_phase:"TEXT NOT NULL DEFAULT 'legacy'",creation_started_at:'BIGINT'})) {
    if(postgres || !columns.has(name)) await db.exec(`ALTER TABLE orders ADD COLUMN ${postgres?'IF NOT EXISTS ':''}${name} ${type}`);
  }
  await db.exec(`CREATE TABLE IF NOT EXISTS buyer_accounts (
    user_id TEXT PRIMARY KEY, email TEXT NOT NULL, phone TEXT, role TEXT NOT NULL DEFAULT 'BUYER' CHECK(role='BUYER'),
    phone_verified_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS buyer_account_sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES buyer_accounts(user_id), expires_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS orders_buyer_idx ON orders(buyer_id);
  CREATE INDEX IF NOT EXISTS buyer_account_sessions_user ON buyer_account_sessions(user_id);`);
  if(postgres) for(const table of ['buyer_accounts','buyer_account_sessions']) await db.exec(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
}
module.exports={migrate};
