# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Next.js web layer (the on-demand UI)
npm run dev          # localhost:3000
npm run build
npx tsc --noEmit

# Deploy the Tensorlake agent (uses uv since system Python is 3.9)
TENSORLAKE_API_KEY=... ~/.local/bin/uv run --python 3.11 \
  --with tensorlake --with openai \
  --with google-auth --with google-auth-httplib2 --with google-api-python-client \
  --with requests --with pydantic \
  python -m tensorlake.cli.deploy agent/larpbot_agent.py

# Renew the Gmail push subscription (expires every 7 days)
GMAIL_WATCH_TOPIC=projects/larpbot-gmail/topics/gmail-watch \
GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... GMAIL_REFRESH_TOKEN=... \
~/.local/bin/uv run --python 3.11 \
  --with google-auth --with google-auth-httplib2 --with google-api-python-client \
  python agent/setup_gmail_watch.py

# Quick health check (recent Tensorlake invocations)
curl -s "https://api.tensorlake.ai/applications/poll_recruiting_inbox/requests?limit=10" \
  -H "Authorization: Bearer $TENSORLAKE_API_KEY" | python3 -m json.tool
```

## Environment

`.env.local` (Next.js) and Tensorlake secrets (agent) share these keys:

```
GITHUB_PAT             # GitHub PAT, repo:read scope
OPENAI_API_KEY         # OpenAI (gpt-4o)
NIA_API_KEY            # Nia (currently broken; non-fatal)
TENSORLAKE_API_KEY     # Tensorlake dashboard
GMAIL_CLIENT_ID        # Google OAuth 2.0 Desktop-app client
GMAIL_CLIENT_SECRET
GMAIL_REFRESH_TOKEN    # obtained via agent/gmail_oauth_setup.py
```

Vercel env vars: at minimum `TENSORLAKE_API_KEY` (used by `app/api/gmail-webhook/route.ts`). Function timeout in `vercel.json` is 60s.

## Architecture

Two layers, no shared runtime.

### 1. Next.js web layer (`app/`, `lib/`)

On-demand HTTP API used by the demo UI **and** by the Gmail push webhook.

- `POST /api/analyze` → in-memory job → poll `GET /api/status/[jobId]`. The browser drives this for the recruiter UI.
- `POST /api/gmail-webhook` → triggered by Cloud Pub/Sub when Gmail receives a new message; immediately POSTs to Tensorlake `poll_recruiting_inbox` and returns 200.
- `lib/openai.ts` — GPT-4o agentic loop (`parseClaims`, `verifyClaim`, `synthesizeOverall`). Mirrors the Python agent's loop but for the on-demand UI.
- `lib/types.ts` — `AnalysisResult` is the canonical shape. If you change it, update `public/demo.json` (the offline fallback).

### 2. Tensorlake always-on agent (`agent/larpbot_agent.py`)

**Single-file deployment.** Tensorlake's deploy command only uploads the `.py` file you pass it; `gmail_client.py` / `memory.py` were inlined into `larpbot_agent.py` because their imports at runtime failed in the container. **Don't add new local module imports** — inline helpers or pass them as Tensorlake secrets/data.

**Pipeline per unread email** (in `poll_recruiting_inbox`):

1. **Three-state dedup gates** (in order):
   - `thread_has_my_larp_report()` — already sent a final LARP Report to this thread → skip forever
   - `last_thread_message_is_from_me()` — we just replied (e.g. help request) and applicant hasn't responded → skip until they reply
   - Otherwise → process
2. **Thread context merge** — `fetch_thread_context()` concatenates *all* applicant messages in the thread (skipping ours). Critical: when an applicant replies with just a URL after our help request, we still need their original claims from email #1.
3. **GitHub URL extraction** — regex over the merged context.
4. **GitHub user existence check** — `github_user_exists()` runs *inline* (not as a Tensorlake sub-function) because **sub-function exceptions do not propagate to parent `try/except`** — the parent gets `function_run_cancelled` and your error handler never runs. Pre-validate inline.
5. If no URL or invalid user → **plain-text reply to the applicant** (not the recruiter inbox) via `send_request_github_email`.
6. `extract_claims_from_email()` → `{username, claims[]}`. **Falls back to a generic claim** if GPT returns empty (otherwise the pipeline silently bails).
7. `index_github_repos()` (Nia indexing — currently fails with DNS error; non-fatal, returns `{}`).
8. `verify_claims()` — agentic loop with 4 tools (`nia_search`, `github_commits`, `github_tree`, `github_file`) and a `submit_verdict` exit. Capped at `MAX_CLAIMS=3` claims and `MAX_TOOL_CALLS=4` per claim for cost.
9. **Pre-send re-check** of `thread_has_my_larp_report` (Pub/Sub at-least-once means two invocations may be processing concurrently — second one bails here once first sends).
10. `send_verdict_email()` → HTML report sent **to the recruiter's own inbox**, threaded as a reply to the applicant's email via `threadId` + `In-Reply-To`. Subject: `LARP Report: <user> — Score X/100 · re: <original>`.

**Tensorlake applications deployed:**
- `poll_recruiting_inbox` — entry point. Triggered by webhook (see below).
- `query_candidates` / `get_candidate` — read endpoints proxied by `app/api/candidates/route.ts`.

### Trigger: Gmail Pub/Sub push (NOT Tensorlake cron)

**Tensorlake's built-in cron is broken for this app** — every cron tick fails with `internal_error` in 2-4ms before any code runs. Manual API invocations of the same function succeed. We don't use it.

**Active trigger path:**

```
applicant emails tungtungrecruiting@gmail.com
    ↓
Gmail publishes to Pub/Sub topic "gmail-watch" (project: larpbot-gmail)
    ↓
Push subscription "gmail-watch-push" → POSTs to https://larpbotapi.vercel.app/api/gmail-webhook
    ↓
Vercel route ack-and-fire-and-forget POSTs to Tensorlake poll_recruiting_inbox
    ↓
Pipeline runs, verdict lands in recruiter's thread within ~30-60s
```

Gmail `watch()` expires after 7 days — re-run `setup_gmail_watch.py` to renew.

**Backup trigger:** `.github/workflows/poll.yml` cron-triggers `poll_recruiting_inbox` every 5 minutes (GitHub's hard minimum). Schedule activations have a 5-15 min delay after pushes and can drift, so it's a safety net, not the primary.

### Receipt URL post-processing

GPT regularly emits receipt URLs missing the owner segment (e.g. `https://github.com/blewIt` instead of `https://github.com/stananan/blewIt`). `_fix_receipt_urls()` rewrites bare repo names and partial URLs using `repo_full_names`. The system prompt also explicitly passes the full `<owner>/<repo>` map.

### Durable memory

`memory_*` helpers use SQLite at `/tmp/larpbot_memory.db`. Tensorlake MicroVM sandboxes preserve filesystem across suspend/resume so the DB survives between invocations. Keyed by lowercase username.

### Demo fallback

`public/demo.json` is a hardcoded `AnalysisResult`. UI's "Load demo" bypasses all APIs.

## Known issues

- **Nia indexing** is unreachable from Tensorlake's container (DNS fails). All Nia calls are wrapped in try/except; the agent falls back to GitHub-only tools (`github_commits`, `github_tree`, `github_file`).
- **Tensorlake cron** is unusable for `poll_recruiting_inbox` (platform bug). Use Gmail push or GitHub Actions instead.
- **GitHub Actions schedules** can be delayed up to 15 min after first push and may skip during runner load.
