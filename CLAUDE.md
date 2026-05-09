# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Next.js web layer
npm run dev        # localhost:3000
npm run build      # production build
npx tsc --noEmit   # type-check only

# Tensorlake agent (Python)
pip install -r agent/requirements.txt

# One-time: get Gmail refresh token
python agent/gmail_oauth_setup.py

# Deploy agent to Tensorlake cloud
tl deploy agent/larpbot_agent.py

# Register the 5-minute cron schedule (run after deploy)
python agent/setup_cron.py

# List / remove schedules
python agent/setup_cron.py --list
python agent/setup_cron.py --delete-all
```

## Environment

`.env.local` (Next.js) and Tensorlake secrets (agent) need the same keys:

```
GITHUB_PAT             # GitHub PAT, repo:read scope
ANTHROPIC_API_KEY      # Anthropic
NIA_API_KEY            # Nia (get credits from Arlan)
TENSORLAKE_API_KEY     # Tensorlake dashboard
GMAIL_CLIENT_ID        # Google OAuth 2.0 Desktop client
GMAIL_CLIENT_SECRET
GMAIL_REFRESH_TOKEN    # obtained via agent/gmail_oauth_setup.py
```

Set Tensorlake secrets with `tl secrets set KEY value` before deploying. Set Vercel vars in the dashboard. Function timeout in `vercel.json` is 60s.

## Architecture

Two separate layers that share no runtime:

### 1. Next.js web layer (`app/`, `lib/`)

On-demand HTTP API for the demo UI. A recruiter pastes a username + claims, the browser polls for results.

**Flow:** `POST /api/analyze` → creates in-memory job → `runAnalysis()` async → `GET /api/status/[jobId]` poll → result in `status.message` when `stage === complete`.

**Files:**
- `lib/github.ts` — GitHub REST API (`getTopRepos`, `getCommitSample`, `getFileTree`, `getFileContent`)
- `lib/nia.ts` — Nia API (`indexRepo`, `pollIndexStatus`, `queryNia`)
- `lib/claude.ts` — `parseClaims` + `verifyClaim` agentic loop (Claude tool use, ≤8 calls) + `synthesizeOverall`
- `lib/types.ts` — shared TypeScript types (`AnalysisResult`, `ClaimVerification`, `Receipt`, `StatusResponse`)
- `lib/jobStore.ts` — in-memory job state (resets on cold start)
- `app/api/candidates/route.ts` — proxies to Tensorlake `query_candidates` / `get_candidate` applications

### 2. Tensorlake always-on agent (`agent/`)

Cron-triggered every 5 minutes. No human required — a recruiter simply emails the recruiting inbox.

**Flow per email:**
1. `fetch_unread_emails()` — Gmail API, finds unread messages with GitHub URLs
2. Check `memory.get_candidate(username)` — skip if already seen, re-send cached verdict
3. `parse_resume_pdf(pdf_b64)` — Tensorlake Document AI parses PDF attachment if present
4. `extract_claims_from_email(body, resume_text)` — single Claude call → `{github_username, claims[]}`
5. `index_github_repos(username)` — top 3 repos indexed with Nia, polled until ready
6. `verify_claims(username, claims, index_ids)` — agentic loop with 4 tools: `nia_search`, `github_commits`, `github_tree`, `github_file`; Claude calls `submit_verdict` per claim
7. `synthesizeOverall` — final Claude call produces LARP score + subscores
8. `memory.store_candidate(username, verdict)` — persisted to SQLite in Tensorlake MicroVM filesystem
9. `send_verdict_email(from_email, username, verdict)` — HTML verdict email back to recruiter

**Durable memory:** `agent/memory.py` uses SQLite at `/tmp/larpbot_memory.db`. Tensorlake MicroVM sandboxes preserve their filesystem across suspend/resume cycles, so this DB persists between cron invocations for the lifetime of the container. Keyed by lowercase GitHub username.

**Tensorlake applications deployed:**
- `poll_recruiting_inbox` — cron entry point (5-min schedule)
- `query_candidates` — returns `list_candidates()` for the Next.js GET proxy
- `get_candidate` — returns one verdict by username

**Cron:** Registered via `python agent/setup_cron.py` which POSTs `{"cron_expression": "*/5 * * * *"}` to the Tensorlake REST API. Minimum interval is 60s; sub-minute expressions are rejected.

### API contract

`lib/types.ts` defines `AnalysisResult` — the shape consumed by `ResultsPanel` and stored in `agent/memory.py`. If you change the shape, update `public/demo.json` too or the demo fallback breaks.

### Demo fallback

`public/demo.json` is a hardcoded `AnalysisResult`. The "Load demo" button on the UI bypasses all APIs. Use it if live analysis fails during the presentation.
