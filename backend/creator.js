// Creator boundary shared by checkout, claims and access grants.
const slug = 'ayla';
const ownsProduct = id => typeof id === 'string' && /^ayla_[a-z0-9_-]+$/.test(id);
function assertProduct(id) { if (!ownsProduct(id)) throw Object.assign(new Error('Produto de outra criadora.'), { status: 403 }); }
function databaseSchema() {
  if (process.env.NODE_ENV === 'test') return null; // existing isolated test harness
  const staging = process.env.APP_ENV === 'staging';
  const schema = staging ? process.env.STAGING_DATABASE_SCHEMA : process.env.DATABASE_SCHEMA;
  if (staging ? !/^staging_ayla_[a-z0-9_]+$/.test(schema || '') : schema !== 'ayla') throw new Error('Ayla requires its dedicated database schema');
  return schema;
}
function assertConfiguration() {
  if (process.env.CREATOR_SLUG && process.env.CREATOR_SLUG !== slug) throw new Error('Creator configuration mismatch');
  if (process.env.DATABASE_URL) databaseSchema();
  if (process.env.NODE_ENV !== 'test' && process.env.VIP_MEDIA_DRIVER === 'supabase' && process.env.VIP_MEDIA_BUCKET !== 'vip-ayla') throw new Error('Ayla requires private bucket vip-ayla');
}
module.exports = { slug, ownsProduct, assertProduct, databaseSchema, assertConfiguration };
