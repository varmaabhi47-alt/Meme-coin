CREATE TABLE IF NOT EXISTS curated_smart_wallets (
  address TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','WATCH','MUTED')),
  median_buy_sol REAL NOT NULL DEFAULT 0,
  confidence_score REAL NOT NULL DEFAULT 0,
  correlation_group TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_curated_wallet_status ON curated_smart_wallets(status,confidence_score);
