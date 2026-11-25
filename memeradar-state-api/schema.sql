-- Applied to the existing memeradar_portfolio D1 database.
-- The existing portfolio_state table uses id='main', payload, updated_at.
-- Version column migration (already applied to the live D1 database):
ALTER TABLE portfolio_state ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
