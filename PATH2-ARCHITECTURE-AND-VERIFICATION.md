# MEME.RADAR Path 2 — Architecture & Verification

## Scope

Path 2 is an event-driven, paper-first Solana discovery and asymmetric-exit engine. No simulated quotes, fabricated wallet metrics, or silent provider fallbacks are permitted. `LIVE_TRADING=false` remains the default. D1 authentication/versioned sync is intentionally deferred at the owner's request and must not be described as fixed.

## File-by-file architecture

- `path2-runtime.mjs`: standard Solana JSON-RPC rate/credit guard, 15-minute cache, WebSocket logs listener, observed-wallet confluence, and outlier-adjusted edge metrics. Standard WSS only; no paid gRPC.
- `meme-radar-v5-intelligence.mjs`: candidate prefilter, liquidity/FDV and anti-chase filters, hard authority/holder/creator gates, RugCheck/GoPlus fail-closed scoring, and bundle-gate helpers.
- `meme-radar-v5-risk-engine.mjs`: pure position risk rules, position sizing, daily/consecutive-loss circuit breakers, and serialized state lock.
- `meme-radar-bot.mjs`: persistent runtime. Fast position monitor runs every 10 seconds only when positions exist; discovery runs every 180 seconds or when an event requests it. Both loops use a shared lock. The scheduled GitHub Actions workflow remains a separate one-scan mode and is not a 24/7 process.
- `execution-adapter.mjs`: paper adapter is the default. Live adapter remains disabled unless both explicit live flags/confirmation are present and its required transaction client is configured.
- `memeradar-state-api/worker.js`: Helius webhook intake and D1-backed state/smart-wallet endpoints. D1 state auth/version checks are not included in this change. The push-time D1 CI gate is disabled unless repository variable `MEMERADAR_D1_SYNC_ENABLED=true` is set.
- `index.html`: dashboard reads the Worker authoritative portfolio and shows a sync-failure status without loading a browser-local portfolio. Continue reviewing remaining DOM render paths for metadata injection.
- `smart_wallets.json`: only RPC-vetted wallets may be populated. The checked-in list is empty; do not seed guessed addresses or statistics.
- `Dockerfile` / `.env.example`: Node 22 low-memory persistent host configuration; all credentials are environment secrets.

## Current strategy values

- Entry size: 5% equity base; standard RESEARCH 0.75x, RESEARCH with smart-money confluence 1.0x; hard cap 0.30% pool liquidity and available cash.
- Stage 1: sell half at +40% net; remaining position has +2% net stop.
- Runner: 15% peak drawdown through +100% peak gain; 22% above +100%; no fixed take-profit cap.
- Emergency liquidity: >30% from entry or >15% from prior monitor observation.
- Daily circuit breaker: -10% rolling 24-hour equity PnL; pause entries 12 hours. Three consecutive risk exits pause entries for 2 hours.
- Discovery anti-chase: 5-minute change >+30% reject; 1-hour >+150% reject; 5-minute buy ratio >=55%; 1-hour >=52%; liquidity/FDV >=8%; >5% decline from first observed liquidity rejects.
- RPC budget: <=6 requests/second and estimated monthly usage throttles above 800,000 credits.

## Verification checklist

Run on the persistent host/repository after configuration. Never use fabricated API responses as production fallbacks.

1. **Credit guard** — test 6 RPS limiter, 429 exponential backoff, cache hit (no second RPC), daily telemetry, and monthly projected-usage throttle.
2. **WSS/webhook** — verify standard `logsSubscribe` subscription acknowledgements; verify migration/Raydium event logs enqueue a mint only after a successful transaction lookup; verify webhook authorization and that wallet buys require two distinct configured wallets within 15 minutes. Current wallet file is empty, so confluence cannot be proven until vetted addresses are supplied.
3. **Fast exits** — with an explicitly designated paper fixture, test +40% net half exit, +2% net runner stop, 15%/22% peak trails, >30% entry liquidity loss, and >15% single-tick liquidity loss. Confirm CSV and `paper_portfolio.json` partial-exit accounting.
4. **D1 versioned sync** — DEFERRED. Previously returned HTTP 401. Verify read auth, expected version/updated_at conflict (409), successful increment, and webhook D1 write after secrets are aligned.
5. **Telegram** — test only configured `TELEGRAM_CHAT_ID`: status, pause/resume, /kill and exit handling; reject all other chat IDs. Confirm paper mode never submits a swap.
6. **Security/data integrity** — run `npm run check`, `npm test`; ensure API/RPC errors remain visible, unknown RugCheck/GoPlus data rejects, no paid gRPC/Enhanced Transactions/Wallet API is called, and browser storage cannot override portfolio.
7. **Live readiness** — remains NOT APPROVED until all tests pass on real provider data and >=100 closed paper trades pass outlier-adjusted proof. `LIVE_TRADING=false` stays in force.

## Known limitations / honest status

- D1 sync is deferred; do not expect state synchronization to work until credentials are fixed. The workflow now skips push-time D1 sync by default; turn it back on only after repairing the secret.
- No smart wallets are seeded; real confluence requires manually curated, RPC-vetted addresses.
- GitHub Actions schedule is 5-minute scan mode; persistent mode requires a continuously running Node host. Free hosting may sleep or impose limits; do not claim guaranteed free 24/7 uptime.
- Standard WSS event subscriptions and quote/exit behavior require live integration verification; unit tests alone do not establish provider connectivity.
- Do not enable live trading based solely on this checklist or a successful CI run.
