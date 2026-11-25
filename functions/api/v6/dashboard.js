export async function onRequest(context) {
  const incoming = new URL(context.request.url);
  const upstream = new URL("https://memeradar-v6-public.varmaabhi47.workers.dev/dashboard");
  upstream.search = incoming.search;
  // Redirect the browser to the public read-only Worker. Do not fetch it
  // from inside Pages: same-zone Worker-to-Worker subrequests can return 1042.
  return new Response(null, {
    status: 302,
    headers: {
      "Location": upstream.toString(),
      "Cache-Control": "no-store"
    }
  });
}