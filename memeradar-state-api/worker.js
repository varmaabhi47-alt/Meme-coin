/**
 * MEME.RADAR authoritative portfolio state Worker.
 * Bind D1 as DB; configure STATE_SYNC_TOKEN as a Worker secret.
 */
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
function authorized(request, env) {
  const expected = String(env.STATE_SYNC_TOKEN || env.MEMERADAR_SYNC_SECRET || "");
  const got = request.headers.get("authorization") || "";
  return expected.length > 0 && got === `Bearer ${expected}`;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
      "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "Authorization,Content-Type", "access-control-max-age": "86400"
    }});
    if (url.pathname !== "/state") return json({ error: "not_found" }, 404);
    if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
    if (request.method === "GET") {
      const row = await env.DB.prepare("SELECT portfolio_json, version, updated_at FROM portfolio_state WHERE id=1").first();
      if (!row) return json({ portfolio: null, version: 0, updated_at: null });
      let portfolio;
      try { portfolio = JSON.parse(row.portfolio_json); } catch { return json({ error: "corrupt_state_json" }, 500); }
      return json({ portfolio, version: Number(row.version), updated_at: row.updated_at });
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    let body;
    try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
    if (!body || !body.portfolio || !Number.isSafeInteger(Number(body.version)) || Number(body.version) < 0) {
      return json({ error: "portfolio_and_nonnegative_version_required" }, 400);
    }
    const serialized = JSON.stringify(body.portfolio);
    if (serialized.length > 2_000_000) return json({ error: "state_too_large" }, 413);
    const expectedVersion = Number(body.version), updatedAt = new Date().toISOString();
    const update = await env.DB.prepare(
      "UPDATE portfolio_state SET portfolio_json=?, version=version+1, updated_at=? WHERE id=1 AND version=?"
    ).bind(serialized, updatedAt, expectedVersion).run();
    if (!update.meta?.changes) {
      const current = await env.DB.prepare("SELECT version, updated_at FROM portfolio_state WHERE id=1").first();
      return json({ success: false, error: "version_conflict", version: Number(current?.version || 0), updated_at: current?.updated_at || null }, 409);
    }
    return json({ success: true, version: expectedVersion + 1, updated_at: updatedAt });
  }
};
