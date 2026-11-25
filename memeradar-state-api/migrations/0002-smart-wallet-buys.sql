CREATE TABLE IF NOT EXISTS smart_wallet_buys (
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  signature TEXT NOT NULL,
  slot INTEGER NOT NULL DEFAULT 0,
  occurred_at INTEGER NOT NULL,
  PRIMARY KEY(wallet, mint, signature)
);
CREATE INDEX IF NOT EXISTS idx_smart_wallet_buys_mint_time ON smart_wallet_buys(mint, occurred_at);
