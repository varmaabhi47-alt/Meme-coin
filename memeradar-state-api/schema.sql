-- Applied to the existing memeradar_portfolio D1 database.
-- The existing portfolio_state table uses id='main', payload, updated_at.
-- Version column migration (already applied to the live D1 database):
ALTER TABLE portfolio_state ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

-- Path 2 event-driven smart-money observations (Helius standard webhook).
CREATE TABLE IF NOT EXISTS smart_wallet_buys (
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  signature TEXT NOT NULL,
  slot INTEGER NOT NULL DEFAULT 0,
  occurred_at INTEGER NOT NULL,
  sol_amount REAL NOT NULL DEFAULT 0,
  correlation_group TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(wallet, mint, signature)
);
CREATE INDEX IF NOT EXISTS idx_smart_wallet_buys_mint_time ON smart_wallet_buys(mint, occurred_at);
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
