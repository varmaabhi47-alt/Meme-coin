# Smart-wallet curator (Meme Radar V6)

This module is **read-only curation and paper-research telemetry**. It does not sign or submit trades.

## Cost and RPC safety

- Use the Helius Free plan and standard Solana RPC methods only: `getSignaturesForAddress` and `getTransaction`.
- Live RPC requires `HELIUS_API_KEY` and a Helius RPC URL. The curator intentionally refuses to fall back to an unknown provider.
- `RPC_MAX_RPS` is clamped to 1–6. JSON-RPC transaction batches contain at most six calls and are paced as six RPC calls/second or less.
- The local `rpc-curator-usage.json` ledger counts each RPC item as one credit, including each item inside a batch. The 1,000,000-credit monthly guard is fail-closed. Provider dashboards remain authoritative; do not treat local estimates as billing telemetry.
- The weekly GitHub Actions workflow persists this ledger and wallet state back to the repository. Do not delete the ledger mid-month unless you have reconciled Helius usage.

## Candidate sources

Manual import:

```sh
node smart-wallet-curator.mjs --import candidates.csv
node smart-wallet-curator.mjs --import candidates.json
```

Direct mint discovery:

```sh
node smart-wallet-curator.mjs --from-mints MINT_A,MINT_B
```

Research winners:

```sh
node smart-wallet-curator.mjs --from-research
node smart-wallet-curator.mjs --from-research paper_research.jsonl
```

Research mode is fail-closed: it requires a Solana research row with a listed pair and passing security status, plus at least five closed paper trades for that exact mint/pair whose combined net PnL is positive in `paper_portfolio.json`. It **does not** use the portfolio-wide `paperLearning.totalPnlUsd` as per-token evidence.

Parser verification and safe dry run:

```sh
node smart-wallet-curator.mjs --dry-run
node smart-wallet-curator.mjs --verify-signature SIGNATURE --wallet WALLET_ADDRESS
```

Weekly pruning:

```sh
node sync-smart-wallet-buys.mjs
node attribute-curator-outcomes.mjs
node smart-wallet-curator.mjs --prune
node sync-helius-webhook.mjs
```

## Qualification rules

A wallet must pass all measured gates: recognized DEX SOL-pair buy/sell reconstruction; at least five net-profitable distinct mints; no mint contributes over 60% of positive net mint profits; median hold at least 10 minutes; no near-instant same/adjacent-slot round-trip; at least 10 closed trades and 10 observed swaps; activity within seven days; median buy at least 0.25 SOL; win rate at least 45%; profit factor at least 1.8; positive realized net PnL; no known-risk/tracked/shared-funding relationship.

Only unambiguous single-token SOL-pair swaps are counted. Network fees remain in observed wallet cashflows. Transfers, airdrops, multi-leg swaps, unresolved address lookup tables, unknown DEX programs, and ambiguous native transfers are skipped rather than estimated.

Wallet metadata is stored in `smart_wallets.json`. ACTIVE is capped at 50; overflow remains WATCH. WATCH and MUTED wallets are not automatically reactivated by pruning.

## Outcome attribution and pruning

Observed wallet buys are exported from authenticated Worker D1 to `smart_wallet_buys.json`. `attribute-curator-outcomes.mjs` joins those events to actual `paper_research.jsonl` price snapshots and records 15m, 60m, and 4h outcomes. Missing entry or horizon prices stay null; no synthetic outcomes are written.

Weekly pruning uses observed last activity and actual attributed outcomes:
- inactive more than 14 days,
- 14-day hit rate below 35% after adequate samples,
- two or more explicitly recorded rug entries.

The weekly workflow runs Sunday 03:15 UTC and requires these GitHub Actions secrets:
`HELIUS_API_KEY`, `HELIUS_RPC_URL`, `HELIUS_WEBHOOK_URL`, `HELIUS_WEBHOOK_AUTH`, and `BOT_SYNC_SECRET`. Optional Telegram secrets: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. `HELIUS_WEBHOOK_AUTH` must match the Worker `HELIUS_WEBHOOK_SECRET`; the Worker must have `BOT_SYNC_SECRET` and its D1 schema deployed.

## Verification

```sh
npm run check
npm test
npm run curator-dry-run
npm run attribute-wallet-outcomes-dry-run
```

Tests use local fixtures only and do not call RPC. Real-world accuracy still depends on provider data, actual wallet histories, deployed Worker/D1 schema, and correctly configured secrets. The supported DEX program set is intentionally conservative and will miss unsupported routes rather than invent PnL.
