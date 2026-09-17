const crypto = require('crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function matches(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return crypto.timingSafeEqual(Buffer.from(hash(value), 'hex'), Buffer.from(expected, 'hex'));
}
module.exports = { hash, matches };
