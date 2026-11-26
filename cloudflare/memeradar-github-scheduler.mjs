/**
 * Meme Radar GitHub Actions scheduler.
 *
 * Cloudflare Cron Trigger dispatches the repository's paper-bot workflow.
 * Required secret: GITHUB_TOKEN (fine-grained PAT, repository Actions: write).
 * Cron: every five minutes (UTC).
 */
const OWNER = "varmaabhi47-alt";
const REPO = "Meme-coin";
const WORKFLOW = "memeradar-paper-bot.yml";
const REF = "main";

async function dispatchPaperBot(token) {
  const response = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: REF }),
    },
  );

  if (response.status !== 204 && !response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`GitHub workflow dispatch failed: HTTP ${response.status} ${detail}`);
  }
  return { dispatched: true, status: response.status, workflow: WORKFLOW, ref: REF };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "memeradar-github-scheduler",
        tokenConfigured: Boolean(env.GITHUB_TOKEN),
        schedule: "*/5 * * * *",
      }, { headers: { "Cache-Control": "no-store" } });
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller, env) {
    if (!env.GITHUB_TOKEN) {
      console.error("GITHUB_TOKEN secret is not configured; skipping dispatch.");
      return;
    }
    const result = await dispatchPaperBot(env.GITHUB_TOKEN);
    console.log(JSON.stringify({
      event: "paper_bot_dispatch",
      cron: controller.cron,
      scheduledTime: new Date(controller.scheduledTime).toISOString(),
      ...result,
    }));
  },
};
