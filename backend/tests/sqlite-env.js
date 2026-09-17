// Load before application modules: test processes cannot inherit production DB/Storage.
process.env.NODE_ENV = 'test';
process.env.BUYER_ACCOUNT_FLOW = 'false';
process.env.APP_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.VIP_MEDIA_DRIVER = 'local';
process.env.VERCEL = '';
process.env.ENABLE_TELEGRAM_BOT = 'false';

process.env.WHATSAPP_NUMBER = '';
process.env.WHATSAPP_PRICE = '7.90';
