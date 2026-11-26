# Meme Radar GitHub Actions Scheduler

The Cloudflare Worker `memeradar-github-scheduler` is deployed and its Cron Trigger is configured for every five minutes (UTC). The GitHub Actions workflow no longer has its own scheduled trigger, preventing duplicate timer runs.

## Required secret — not yet configured

Create a GitHub fine-grained personal access token:
- Repository access: only `varmaabhi47-alt/Meme-coin`
- Repository permission: **Actions — Read and write**
- No Contents, Administration, or other permissions are required for workflow dispatch.

In Cloudflare Dashboard:
1. Open **Workers & Pages** → `memeradar-github-scheduler`.
2. Open **Settings** → **Variables and Secrets**.
3. Add a secret named `GITHUB_TOKEN` with the token value.
4. Do not put the token in this repository, code, Telegram, or a chat message.

Until the secret is added, scheduled invocations log a clear message and skip dispatch. Add it promptly to resume automated scans.

## How it works

The Worker dispatches `memeradar-paper-bot.yml` on `main` using GitHub's workflow-dispatch API. GitHub Actions continues to perform the paper scan, authenticated D1 check, Telegram notifications, and portfolio save; this Worker does not simulate market data or execute trades.

The workflow retains `workflow_dispatch` for manual runs and its existing push behavior. The Cloudflare Cron Trigger is `*/5 * * * *` (UTC).
