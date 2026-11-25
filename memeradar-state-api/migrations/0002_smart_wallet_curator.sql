-- Apply ONCE to an existing D1 database that has the original
-- smart_wallet_buys table (wallet, mint, signature, slot, occurred_at only).
-- If the two columns have already been added manually, omit their ALTER lines.
ALTER TABLE smart_wallet_buys ADD COLUMN sol_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE smart_wallet_buys ADD COLUMN correlation_group TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_smart_wallet_buys_wallet_time ON smart_wallet_buys(wallet, occurred_at);

CREATE TABLE IF NOT EXISTS curated_smart_wallets (
  address TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','WATCH','MUTED')),
  median_buy_sol REAL NOT NULL DEFAULT 0,
  confidence_score REAL NOT NULL DEFAULT 0,
  correlation_group TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_curated_smart_wallets_status ON curated_smart_wallets(status);

CREATE TABLE IF NOT EXISTS token_gate_status (
  mint TEXT PRIMARY KEY,
  passed INTEGER NOT NULL CHECK(passed IN (0,1)),
  checked_at INTEGER NOT NULL,
  reasons TEXT NOT NULL DEFAULT '[]'
);
