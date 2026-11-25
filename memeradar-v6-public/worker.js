const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
};
function headers() { return CORS; }
function json(data, status, request) {
  return Response.json(data, { status: status || 200, headers: headers(request) });
}
const nowMs = () => Date.now();
async function mintConfluence(env, mint, now) {
  const active = await env.DB.prepare("SELECT address,median_buy_sol,correlation_group FROM curated_smart_wallets WHERE status='ACTIVE'").all();
  const rows = await env.DB.prepare("SELECT wallet,slot,occurred_at,sol_amount,correlation_group FROM smart_wallet_buys WHERE mint=? AND occurred_at>=? AND occurred_at<=? ORDER BY occurred_at DESC").bind(mint, now - 15 * 60 * 1000, now).all();
  const gate = await env.DB.prepare("SELECT passed,checked_at FROM token_gate_status WHERE mint=?").bind(mint).first();
  const byAddress = new Map((active.results || []).map(w => [String(w.address), w]));
  const eligible = (rows.results || []).filter(row => {
    const w = byAddress.get(String(row.wallet));
    const amount = Number(row.sol_amount), median = Number(w?.median_buy_sol), at = Number(row.occurred_at);
    return !!w && Number.isFinite(at) && at >= now - 15 * 60 * 1000 && at <= now && Number.isFinite(amount) && amount > 0 && Number.isFinite(median) && median > 0 && amount >= median * 0.5;
  });
  const groups = new Map();
  for (const row of eligible) {
    const w = byAddress.get(String(row.wallet));
    const group = String(w?.correlation_group || row.correlation_group || row.wallet);
    if (!groups.has(group)) groups.set(group, row);
  }
  const independent = [...groups.values()];
  const slots = new Set(independent.map(r => Number(r.slot)).filter(Number.isFinite));
  const checkedAt = Number(gate?.checked_at);
  const gateFresh = !!gate && (gate.passed === true || Number(gate.passed) === 1) && Number.isFinite(checkedAt) && checkedAt <= now && now - checkedAt <= 5 * 60 * 1000;
  const signal = independent.length >= 2 && slots.size >= 2 && gateFresh;
  return {
    mint,
    independentGroups: independent.length,
    distinctSlots: slots.size,
    required: 2,
    gateFresh,
    signal: signal ? "SMART_MONEY_CONFLUENCE" : null,
    latest: Math.max(0, ...independent.map(r => Number(r.occurred_at) || 0)),
    reasons: [
      ...(independent.length < 2 ? ["insufficient-independent-wallets"] : []),
      ...(slots.size < 2 ? ["insufficient-distinct-slots"] : []),
      ...(!gateFresh ? ["token-gate-missing-stale-or-failed"] : [])
    ]
  };
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(request) });
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, request);
    if (url.pathname === "/health") return json({ service: "MEME.RADAR V6 public read API", status: "ok", storage: "Cloudflare D1", mode: "read-only", simulated: false }, 200, request);
    if (url.pathname !== "/dashboard") return json({ error: "not_found" }, 404, request);
    try {
      const now = nowMs(), since = now - 15 * 60 * 1000;
      const [walletRows, buySummary, gateSummary] = await Promise.all([
        env.DB.prepare("SELECT status,COUNT(*) AS count FROM curated_smart_wallets GROUP BY status").all(),
        env.DB.prepare("SELECT COUNT(*) AS buys,COUNT(DISTINCT mint) AS mints FROM smart_wallet_buys WHERE occurred_at>=? AND occurred_at<=?").bind(since, now).first(),
        env.DB.prepare("SELECT COUNT(*) AS count FROM token_gate_status WHERE passed=1 AND checked_at>=? AND checked_at<=?").bind(now - 5 * 60 * 1000, now).first()
      ]);
      const counts = { ACTIVE: 0, WATCH: 0, MUTED: 0 };
      for (const row of walletRows.results || []) counts[String(row.status)] = Number(row.count || 0);
      const payload = {
        ok: true,
        observedAt: now,
        simulated: false,
        walletCounts: counts,
        recentBuys15m: Number(buySummary?.buys || 0),
        distinctMints15m: Number(buySummary?.mints || 0),
        freshPassingGates: Number(gateSummary?.count || 0),
        source: "Cloudflare D1 / Helius webhook"
      };
      const mint = String(url.searchParams.get("mint") || "").trim();
      if (mint) {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return json({ error: "invalid_solana_mint_address" }, 400, request);
        payload.mintConfluence = await mintConfluence(env, mint, now);
      }
      return json(payload, 200, request);
    } catch (error) {
      return json({ ok: false, error: "live_d1_read_failed", detail: String(error?.message || error) }, 500, request);
    }
  }
};
