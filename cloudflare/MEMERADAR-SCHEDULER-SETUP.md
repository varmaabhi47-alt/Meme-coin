# Meme Radar GitHub Actions Scheduler

This Worker is the external timer for the Meme Radar paper-bot workflow.

## Required secret

Create a GitHub fine-grained personal access token:
- Repository access: only `varmaabhi47-alt/Meme-coin`
- Repository permission: **Actions — Read and write**
- No Contents, Administration, or other permissions are required for workflow dispatch.

In Cloudflare Dashboard:
1. Open **Workers & Pages** → `memeradar-github-scheduler`.
2. Open **Settings** → **Variables and Secrets**.
3. Add a secret named `GITHUB_TOKEN` with the token value.
4. Do not put the token in this repository, code, Telegram, or a chat message.

## Activate

Once the secret is set, add the Worker Cron Trigger:
```
*/5 * * * *
```

Then remove the `schedule:` trigger from `.github/workflows/memeradar-paper-bot.yml` so the GitHub timer and Cloudflare timer do not run duplicate scans. Keep `workflow_dispatch` and the existing push behavior.

The Worker dispatches `memeradar-paper-bot.yml` on `main` using GitHub's workflow-dispatch API. GitHub Actions continues to perform the paper scan, D1 check, and portfolio save; this Worker does not simulate market data or trade.

## Health check

After enabling the Worker route / workers.dev subdomain, `GET /health` reports whether the secret is present. The response never exposes the secret.
