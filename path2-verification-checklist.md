# Path 2 verification checklist

## Automated in GitHub CI
- [x] Syntax check: bot, intelligence, risk engine, backtest, Worker, runtime and execution adapter.
- [x] RPC guard: mock HTTP 429 retry and estimated credit accounting; configured RPS hard-clamps to six.
- [x] WebSocket event filter: mocked standard logsSubscribe notifications trigger only Pump migration and configured Raydium pool-init patterns.
- [x] Smart-money confluence: requires two distinct wallets for the same mint within 15 minutes.
- [x] Fast-exit risk primitives: +40% partial exit, runner breakeven, liquidity emergencies and trailing-stop rules.
- [x] D1 Worker mock: GET /state requires Bearer auth; matching version + updated_at writes; stale write returns 409.
- [x] Helius Worker mock: webhook auth header, allowlisted wallet and swap-only event accepted; unauthenticated request rejected.
- [x] Telegram parser recognizes /kill; bot command handler accepts only TELEGRAM_CHAT_ID.
- [x] Statistical proof gate: 99 closed trades cannot verify edge; 100-trade test excludes largest winner.
- [x] Live adapter tests: compiled-message `jitodontfront` readonly validation and Helius Sender HTTPS endpoint allowlist.
- [x] Dashboard safety: untrusted pair IDs use dataset-based click handlers; external inspector URLs require HTTPS.
- [x] Inline dashboard JavaScript syntax check runs in CI.
- [x] CI result: Path 2 workflow passed 53 tests, 0 failures (2026-11-25); V5.1 upgrade checks passed.

## Required before enabling live services
- [ ] Configure 15-30 verified smart-wallet addresses; current smart_wallets.json is intentionally empty.
- [ ] Apply memeradar-state-api/migrations/0002-smart-wallet-buys.sql to the existing D1 database.
- [ ] Deploy the Worker code and set HELIUS_WEBHOOK_SECRET (exact Helius Authorization header) plus SMART_WALLETS.
- [ ] Create one Helius enhanced SWAP webhook with matching authHeader; confirm actual delivery and D1 confluence.
- [ ] Connect to configured standard Solana WSS; confirm migration and Raydium events enqueue live candidate mints.
- [ ] Verify live Helius credit telemetry against the provider dashboard; credit counts are estimates and no paid/credit-heavy endpoint is used.
- [ ] Run a paper-only end-to-end fast-exit test using live pair marks and Jupiter quotes; confirm partial exit rows and CSV/D1 persistence.
- [ ] Confirm actual Telegram /status, /pause, /resume and /kill delivery from the authorized chat.
- [ ] Review outlier-adjusted analytics after at least 100 genuine closed paper trades.
- [ ] Do not set LIVE_TRADING=true: the live Jupiter transaction builder and flatten-on-kill execution wiring are not yet production-ready.
