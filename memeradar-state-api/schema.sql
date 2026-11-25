-- Run once against the memeradar-state-api D1 database.
CREATE TABLE IF NOT EXISTS portfolio_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  portfolio_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO portfolio_state (id, portfolio_json, version, updated_at)
VALUES (1, '{"cashUsd":0,"openPositions":[],"closedTrades":[]}', 0, datetime('now'));
