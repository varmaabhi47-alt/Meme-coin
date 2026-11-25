# V6 Smart Wallet Curator

The curator is paper-research tooling only. It does not place trades.

## Zero-cost / data policy
- Uses standard Solana JSON-RPC `getSignaturesForAddress` and `getTransaction` only.
- Never calls Helius Enhanced Transactions or Wallet API endpoints.
- Max request pacing is 6 requests/second; HTTP 429 retries use exponential backoff.
- Successful RPC calls are counted in `rpc-curator-usage.json`; the process stops at a conservative 1,000,000-call monthly cap. RPC providers may meter methods differently, so this is a request budget, not a promise of provider credit equivalence.
- RPC errors, incomplete transaction metadata, unresolved ALT account metadata, non-SOL quote pairs, and missing trade evidence are not synthesized. Such wallets are skipped/rejected.
- `smart_wallets.json` intentionally starts empty. No user wallet was supplied or invented.

## CLI
```sh
# Import CSV (address,label) or JSON array/object candidates
node smart-wallet-curator.mjs --import candidates.csv

# Discover wallets from one or more graduated/winning mints
node smart-wallet-curator.mjs --from-mints MINT_A,MINT_B

# Read research log records with positive paperLearning evidence
node smart-wallet-curator.mjs --from-research paper_research.jsonl

# Scan candidate wallets, apply gates, update smart_wallets.json
node smart-wallet-curator.mjs --import candidates.csv

# Live parser verification with a real transaction signature and wallet address
node smart-wallet-curator.mjs --verify-signature TX_SIGNATURE --wallet WALLET_ADDRESS

# Prune decay/inactivity from actual wallet-attributed research records
node smart-wallet-curator.mjs --prune

# No-network telemetry/budget status
node smart-wallet-curator.mjs --dry-run

# Deterministic local parser and rejection tests (no mocked RPC calls)
npm test
```

Set `SOLANA_RPC_URL` (or `HELIUS_RPC_URL`) and optionally `HELIUS_API_KEY`. Set `KNOWN_DEPLOYER_WALLETS` to a comma-separated, independently verified deployer list. Shared direct SOL funders among the current candidate batch, known deployer funders, and funding from already-curated wallets are hard rejections.

## Accounting boundaries
The first implementation intentionally measures only swaps with identifiable SOL outflow/inflow on a recognized DEX program. It cannot reliably price USDC/other quote-token trades without a verified historical price source, so those swaps are not included in realized PnL. Trade matching is wallet-level FIFO using actual token-balance deltas and SOL balance deltas; this is conservative but not a tax-lot or full portfolio accounting system. Wallets need >=10 reconstructed closed trades and all requested hard gates to pass. An airdrop/transfer cannot become a qualifying buy unless a recognized DEX market buy is observed first.

## Helius + Worker sync
Required environment:
- `HELIUS_API_KEY`
- `HELIUS_WEBHOOK_URL=https://YOUR_WORKER_HOST/webhook/helius`
- `HELIUS_WEBHOOK_AUTH` — same secret as Worker `HELIUS_WEBHOOK_SECRET`
- `BOT_SYNC_SECRET` — same as Worker `BOT_SYNC_SECRET`
- optional `HELIUS_WEBHOOK_ID` to force the one webhook to update

```sh
node sync-helius-webhook.mjs --dry-run
node sync-helius-webhook.mjs
```

The sync script reconciles the webhook account list and posts curated metadata to Worker `/smart-wallets` using the authenticated D1 state secret. The GitHub workflow `.github/workflows/sync-smart-wallets.yml` can run after `smart_wallets.json` changes; configure the listed repository secrets first.

## Cloudflare migrations
Apply in order to the existing D1 database:
- `0002-smart-wallet-buys.sql`
- `0003-smart-wallet-confluence-gates.sql`
- `0004-curated-smart-wallets.sql`

The Worker fails closed: it only records wallet buys for ACTIVE D1 curator entries, checks buy size >= 0.5x the wallet's own median, deduplicates correlated funding groups, requires separate slots and at least 2 (configurable 2–3) independent wallets in 15 minutes, and requires fresh positive V6 gate evidence in `token_gate_status`. The bot must POST a successful V6 hard-gate result to authenticated `/v6-gates` before the Worker emits confluence. That evidence must represent the existing V6 RugCheck, top-10 concentration <=30%, mint/freeze/Token-2022-hook and bundle <=15% checks; the Worker does not independently fetch those sources.

## Current caveats
- A 30-day history scan is credit-bounded and may stop before complete history. Missing coverage must not be treated as a passing score.
- The candidate queue and RPC usage file are local JSON state; back them up.
- Weekly scoring requires research records with wallet attribution and real 15m/60m/4h outcomes. Existing un-attributed research snapshots cannot be assigned to a wallet and will not be guessed.
- Helius webhook delivery credits are provider-side. This module does not claim exact per-event credit cost beyond the configured no-polling architecture.
