# MEME.RADAR V6

**V6 source of truth:** the `main` branch of this repository. The V4 Pages project name is retained for URL compatibility; it does not define the application version.

## Production components

- **Telegram bot / paper trader:** `meme-radar-bot.mjs` and the V5 engine modules.
- **State API:** Cloudflare Worker `memeradar-state-api`, backed by the existing Cloudflare D1 database.
- **V6 public API:** Cloudflare Worker `memeradar-v6-public`, for dashboard smart-money and confluence endpoints.
- **Dashboard:** `index.html`, deployed to the existing `https://memeradar-v4.pages.dev` address.
- **V6 smart-money curator:** `smart-wallet-curator.mjs`, `smart_wallets.json`, swap reconstruction, funding-link detection, wallet outcome attribution, and smart-money confluence modules.

## Safety and data policy

- Real market/RPC data only. No fabricated market quotes or mocked provider responses.
- Paper trading only. Keep `LIVE_TRADING=false`; no live orders are enabled by this V6 baseline.
- The curator is fail-closed when swap accounting or transaction history cannot be verified.
- Curator target is up to 50 ACTIVE wallets; candidates must pass live vetting. Do not manually label unverified wallets ACTIVE.
- Helius RPC usage is capped at 6 requests/second in the curator and tracked locally; provider errors and rate limits are surfaced.
- Keep API keys and sync/webhook secrets in GitHub Actions Secrets and Cloudflare secret bindings. Never commit them or paste them into issues/chat.

## Verify locally

Node.js 24+ recommended.

```sh
npm install
npm run v6:verify
```

The verification script runs the repository syntax checks and automated tests.

## Useful commands

```sh
npm run dry-run
npm run persistent
npm run curator-dry-run
npm run curate-wallets
npm run sync-wallet-webhook
npm run sync-wallet-buys
npm run attribute-wallet-outcomes
```

The persistent bot requires the environment variables and secrets documented in `.env.example`. Use paper mode; do not enable live trading.

## Wallet curator workflow

1. Add candidate addresses through a candidates JSON/CSV/TXT import or research mint discovery.
2. Run the curator with live Helius RPC credentials and review actual telemetry.
3. Only addresses that pass the curator's real-data checks may become ACTIVE.
4. Reconcile the Helius webhook and D1 metadata after the active set changes.
5. Review weekly prune and outcome-attribution reports.

Example candidate file:

```json
{
  "candidates": [
    "CANDIDATE_WALLET_ADDRESS"
  ]
}
```

```sh
node smart-wallet-curator.mjs --import candidates.json --dry-run
```

## GitHub Actions

The repository includes V5 engine and Path 2 CI, live API smoke checks, paper-bot scheduling, smart-wallet sync, curator discovery/verification/weekly maintenance, and weekly pruning. V6 CI runs syntax checks and tests on pushes and pull requests to `main`.

Scheduled Actions are not a substitute for an always-on Telegram polling process. Use a persistent host for continuous bot operation.

## Cloudflare deployment note

Keep the current Pages project and hostname until the final API/CORS checks pass. Both Workers must remain attached to the intended D1 database. Do not delete legacy resources based on their names alone.
