CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT UNIQUE NOT NULL,
  product_id TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'BRL',
  status TEXT NOT NULL DEFAULT 'PENDING',
  payment_provider TEXT,
  provider_payment_id TEXT,
  pix_copy_paste TEXT,
  checkout_hash TEXT,
  pix_qr_code TEXT,
  webhook_token_hash TEXT,
  access_days INTEGER,
  access_type TEXT DEFAULT 'vip',
  customer_name TEXT,
  customer_email TEXT,
  customer_phone TEXT,
  customer_document_hash TEXT,
  customer_document_last3 TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  paid_at DATETIME,
  expires_at DATETIME,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS entitlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  telegram_user_id TEXT,
  product_id TEXT NOT NULL,
  starts_at DATETIME,
  expires_at DATETIME,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS access_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  used_at DATETIME,
  expires_at DATETIME,
  telegram_user_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(order_id) REFERENCES orders(id)
);
