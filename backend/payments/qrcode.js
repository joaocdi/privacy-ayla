const QRCode = require('qrcode');

module.exports = async function renderQrCode(code) {
  if (typeof code !== 'string' || !code || code.length > 4096) throw new Error('PIX code invalid');
  return QRCode.toDataURL(code, { width: 256, margin: 2, errorCorrectionLevel: 'M' });
};
