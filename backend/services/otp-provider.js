// No SMS/WhatsApp adapter is configured. Never claim to send a code.
module.exports = { available: false, async send() {
  throw Object.assign(new Error('Recuperação por código ainda indisponível. Use o aparelho da compra ou fale com o suporte.'), {status:503});
} };
