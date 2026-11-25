# Path 2 setup notes (Free-tier / paper-only)

## Required configuration
- Set `LIVE_TRADING=false` and keep it that way during paper validation.
- Configure `SOLANA_RPC_HTTP` and `SOLANA_RPC_WSS` using standard Helius Free JSON-RPC/WebSocket endpoints. No gRPC, Enhanced Transactions, or Wallet API is used.
- Set `RAYDIUM_PROGRAM_IDS` to the pool programs you intend to watch. Pump.fun migration trigger is configured by `PUMPFUN_PROGRAM_ID`.
- Add 15-30 verified wallet addresses to `smart_wallets.json`; the repository intentionally ships an empty list rather than inventing wallets.
- Keep a persistent volume for `paper_portfolio.json`, `paper_trades.csv`, `paper_research.jsonl`, `rpc-usage.json`, `rpc-usage.json.cache`, and `audit-cache.json`.

## Worker / D1
1. Apply `memeradar-state-api/migrations/0002-smart-wallet-buys.sql` to the existing D1 database.
2. Deploy `memeradar-state-api/worker.js` using the existing Worker and DB binding. The supplied `wrangler.toml` contains a database ID placeholder that must be replaced with the existing DB ID.
3. Set Worker secret `BOT_SYNC_SECRET` to the same value used as `MEMERADAR_SYNC_SECRET` by the bot.
4. Set Worker secret `HELIUS_WEBHOOK_SECRET` to the exact Authorization header string used by the Helius webhook, e.g. `Bearer <random-long-secret>`; set Worker variable `SMART_WALLETS` to the comma-separated allowlist.
5. In Helius, create one enhanced webhook to `https://memeradar-state-api.varmaabhi47.workers.dev/webhook/helius`, transaction type `SWAP`, account addresses equal to the tracked wallet list, and `authHeader` equal to the exact `HELIUS_WEBHOOK_SECRET` value. Helius webhook management may consume credits; do it once, not repeatedly.

## Runtime
- Use `npm start` or `docker run` on an actually always-on free host/your own machine. GitHub Actions is CI/scheduled execution, not a guaranteed 10-second 24/7 process.
- The fast monitor is idle when no positions are open. Discovery runs every 3 minutes and event triggers request an immediate scan.
- Helius/RPC quota guard records estimated credits; the 800k/month threshold is an estimate, not provider billing data.
- No live transaction is sent by CI or by the paper adapter. The live adapter is intentionally isolated and requires injected signing and Sender integrations; it is not production-ready or enabled.
