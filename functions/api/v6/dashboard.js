export async function onRequest(context) {
  const incoming = new URL(context.request.url);
  const upstream = new URL("https://memeradar-v6-public.varmaabhi47.workers.dev/dashboard");
  upstream.search = incoming.search;
  try {
    const response = await fetch(upstream.toString(), {
      method: "GET",
      headers: { "Accept": "application/json" },
      cache: "no-store"
    });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") || "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    return Response.json({
      ok: false,
      error: "v6_upstream_fetch_failed",
      detail: String(error?.message || error)
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}