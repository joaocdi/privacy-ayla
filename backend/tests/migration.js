require('./sqlite-env');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
process.env.DATABASE_PATH = path.resolve(__dirname, '..', '.test-runs', crypto.randomUUID() + '.sqlite');
async function main() {
  const legacy = await open({ filename: process.env.DATABASE_PATH, driver: sqlite3.Database });
  const oldSchema = fs.readFileSync(path.resolve(__dirname, '..', 'db/schema.sql'), 'utf8')
    .replace(/^  (checkout_hash|pix_qr_code|webhook_token_hash|access_days|access_type).*\r?\n/gm, '');
  await legacy.exec(oldSchema);
  await legacy.exec(`INSERT INTO orders (public_id,product_id,amount,status,paid_at) VALUES ('legacy','ayla_monthly',9.9,'PAID',CURRENT_TIMESTAMP);
    INSERT INTO entitlements (order_id,product_id,status) VALUES (1,'ayla_monthly','ACTIVE');
    INSERT INTO entitlements (order_id,product_id,status) VALUES (1,'ayla_monthly','EXPIRED');`);
  // vip_posts como era antes da prévia da HOME: as colunas são acrescentadas
  // pelo initDb, sem recriar a tabela e sem perder publicações.
  await legacy.exec(`CREATE TABLE vip_posts (
    id TEXT PRIMARY KEY, creator_id TEXT NOT NULL DEFAULT 'ayla', type TEXT NOT NULL,
    media_path TEXT NOT NULL, media_driver TEXT NOT NULL, caption TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO vip_posts(id,type,media_path,media_driver,caption,published) VALUES ('antigo','image','ayla/a.jpg','supabase','ja existia',1);`);
  await legacy.close();
  const { initDb, closeDb } = require('../db/database');
  const db = await initDb();
  const upgraded = await db.get("SELECT * FROM vip_posts WHERE id='antigo'");
  assert.equal(upgraded.caption, 'ja existia');
  assert.equal(upgraded.show_as_preview, 0, 'post antigo nunca vira prévia da HOME sozinho');
  assert.equal(upgraded.preview_image, null);
  await initDb();
  assert.equal((await db.get('SELECT COUNT(*) n FROM vip_posts')).n, 1, 'migração repetida não duplica nem apaga posts');
  assert.equal((await db.get('SELECT COUNT(*) n FROM entitlements')).n,1);
  assert.equal((await db.get('SELECT COUNT(*) n FROM entitlement_duplicates_archive')).n,1);
  assert.equal((await db.get('SELECT status FROM entitlements')).status,'ACTIVE');
  await initDb();
  assert.equal((await db.get('SELECT COUNT(*) n FROM entitlement_duplicates_archive')).n,1);
  await assert.rejects(db.run("INSERT INTO entitlements(order_id,product_id) VALUES(1,'ayla_monthly')"));
  await closeDb();
  console.log('PASS: legacy migration preserves active grant and archives expired duplicate, repeat safe');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
