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
  PRIMARY KEY(wallet, mint, signature)
);
CREATE INDEX IF NOT EXISTS idx_smart_wallet_buys_mint_time ON smart_wallet_buys(mint, occurred_at);
