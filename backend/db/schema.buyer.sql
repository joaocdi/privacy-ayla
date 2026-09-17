CREATE TABLE IF NOT EXISTS buyer_recovery (
 id TEXT PRIMARY KEY,
 phone TEXT NOT NULL,
 code_hash TEXT NOT NULL,
 expires_at BIGINT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS buyer_recovery_limits (
 id TEXT PRIMARY KEY,
 hits INTEGER NOT NULL DEFAULT 0,
 reset_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS buyer_sessions (
 id TEXT PRIMARY KEY,
 order_id INTEGER NOT NULL REFERENCES orders(id),
 token_hash TEXT NOT NULL UNIQUE,
 expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS buyer_sessions_order ON buyer_sessions(order_id);
