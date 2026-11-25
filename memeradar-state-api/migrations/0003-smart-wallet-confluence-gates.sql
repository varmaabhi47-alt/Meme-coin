ALTER TABLE smart_wallet_buys ADD COLUMN sol_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE smart_wallet_buys ADD COLUMN correlation_group TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS token_gate_status (
  mint TEXT PRIMARY KEY,
  passed INTEGER NOT NULL CHECK (passed IN (0,1)),
  checked_at INTEGER NOT NULL,
  reasons TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_token_gate_checked ON token_gate_status(checked_at);
