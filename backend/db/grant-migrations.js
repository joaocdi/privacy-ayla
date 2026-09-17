// Additive scope for future PPV. Existing purchases remain subscriptions/contact.
async function migrate(db, postgres = false) {
  for (const table of ['orders', 'entitlements']) {
    const columns = postgres ? null : new Set((await db.all(`PRAGMA table_info(${table})`)).map(c => c.name));
    for (const [name, definition] of Object.entries({
      grant_type: "TEXT NOT NULL DEFAULT 'subscription' CHECK(grant_type IN ('subscription','ppv','contact'))",
      resource_type: 'TEXT', resource_id: 'TEXT'
    })) {
      if (postgres || !columns.has(name)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${postgres ? 'IF NOT EXISTS ' : ''}${name} ${definition}`);
    }
  }
  await db.run("UPDATE orders SET grant_type='contact' WHERE access_type='whatsapp' AND grant_type='subscription'");
  await db.run("UPDATE entitlements SET grant_type='contact' WHERE grant_type='subscription' AND order_id IN (SELECT id FROM orders WHERE grant_type='contact')");
  await db.exec('CREATE INDEX IF NOT EXISTS entitlement_resource_idx ON entitlements(grant_type,resource_type,resource_id,order_id)');
}
module.exports = { migrate };
