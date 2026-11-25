# Path 2 verification checklist
- [ ] RPC credit guard: mock 429 responses; verify exponential backoff, <=6 requests/second, cache hits within 15 minutes, usage telemetry and 800k projected-month throttle.
- [ ] WebSocket trigger: connect to configured standard Solana WSS; confirm only migration / pool-init log patterns enqueue candidates; confirm no polling fallback.
- [ ] Helius webhook: send a signed test payload to Worker; reject invalid signature; verify wallet allow-list, mint buy row, duplicate suppression and 15-minute distinct-wallet confluence in D1.
- [ ] Fast exit: use a deterministic unit test fixture (not market data) to verify partial 50% de-risk at +40%, breakeven runner stop, 15% / 22% trail, >30% entry liquidity emergency and >15% tick emergency.
- [ ] D1 version sync: authenticated GET, matching version POST, stale version returns 409, updated_at/version increments only on successful write.
- [ ] Telegram: authorized chat /status, /pause, /resume, /kill; reject every other chat; /kill halts entries and invokes live-position flatten callback only when live execution is explicitly enabled.
- [ ] Paper-only guard: LIVE_TRADING=false; no swap transaction submission or Helius Sender request in tests.
- [ ] Statistical proof: EDGE_VERIFIED remains false under 100 closed trades and excludes largest winning trade in adjusted PnL/PF.
