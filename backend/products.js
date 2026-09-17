const whatsappPrice = Number(process.env.WHATSAPP_PRICE || '7.90');
if (!Number.isFinite(whatsappPrice) || whatsappPrice <= 0 || Math.round(whatsappPrice * 100) / 100 !== whatsappPrice) throw new Error('Invalid WHATSAPP_PRICE');
const products = {
  ayla_tip: { id: 'ayla_tip', name: 'Mimo', price: 5, type: 'tip', minCents: 500, maxCents: 1000000 },
  ayla_whatsapp_unlock: { id: 'ayla_whatsapp_unlock', name: 'Contato privado', price: whatsappPrice, type: 'one_time', get enabled() { return /^\d{10,15}$/.test((process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '')); } },
  ayla_monthly: {
    id: "ayla_monthly",
    name: "1 mês",
    price: 9.90,
    accessDays: 30
  },

  ayla_quarterly: {
    id: "ayla_quarterly",
    name: "3 meses",
    price: 19.90,
    accessDays: 90
  },

  ayla_semester: {
    id: "ayla_semester",
    name: "6 meses",
    price: 29.90,
    accessDays: 180
  }
};

module.exports = products;
