const media = require('./vip-media');
// Only the branding path selected by profile.image() may enter this function.
// Paid media continues through its existing authenticated, signed delivery.
async function bytes(objectPath) {
  if (!media.safeObjectPath(objectPath)) throw new Error('Invalid profile media');
  const base = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.VIP_MEDIA_BUCKET;
  if (!base || !key || !bucket) throw new Error('Profile storage unavailable');
  const encoded = objectPath.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`${base}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${encoded}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('Profile image unavailable');
  const type = response.headers.get('content-type')?.split(';')[0];
  if (!['image/jpeg','image/png','image/webp'].includes(type)) throw new Error('Invalid profile image type');
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > 10 * 1024 * 1024) throw new Error('Profile image too large');
  return { body, type };
}
module.exports = { bytes };
