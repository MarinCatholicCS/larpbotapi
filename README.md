# LARPbot

Always-on AI agent that verifies developer claims against their actual GitHub code.

A recruiter forwards an applicant's email (with a `github.com/<username>` link) to **`tungtungrecruiting@gmail.com`**. Within ~60 seconds, a **LARP Report** lands in the same thread — scored 0–100, with receipts pulled from real commits and source files.

## How it works

```
applicant emails the recruiting inbox
        │
        ▼
Gmail publishes a Pub/Sub event
        │
        ▼
Vercel webhook (/api/gmail-webhook) pings Tensorlake
        │
        ▼
Tensorlake agent (poll_recruiting_inbox)
   ├─ fetches the full email thread (preserves context across replies)
   ├─ extracts GitHub URL + claims (GPT-4o)
   ├─ runs an agentic verification loop over the candidate's repos
   │     using tools: github_commits, github_tree, github_file, nia_search
   ├─ synthesizes a 0–100 LARP score + subscores + receipts
   └─ replies in-thread with the report
        │
        ▼
recruiter sees the report under the original email
```

The whole pipeline is event-driven — no human triggers anything, no polling. Cron is a fallback only.

## What's in a report

- **LARP Score** (0–100) and one-sentence verdict
- **Subscores**: skill inflation, project substance, role authenticity, code depth
- **Receipts**: per-claim links to specific commits or files in their actual repos
- **Recent Activity**: 5 most recent commits per analyzed repo
- **What to Ask Next**: targeted interview questions for unverified claims

If the email doesn't contain a GitHub URL (or points to a non-existent profile), the **applicant** gets a friendly plain-text reply asking for one. The recruiter inbox stays clean.

## Tech stack

| Layer | What it does | Where |
|---|---|---|
| Next.js (Vercel) | On-demand UI + Gmail Pub/Sub webhook | `app/`, `lib/` |
| Tensorlake | Always-on agent runtime — runs the verification pipeline | `agent/larpbot_agent.py` |
| OpenAI GPT-4o | Claim extraction + agentic verification loop | tool-use API |
| Gmail API | Inbox polling, push notifications, sending replies | inlined in agent |
| Cloud Pub/Sub | Event delivery from Gmail to webhook | GCP |
| GitHub REST | Source-of-truth for repos, commits, file contents | `lib/github.ts`, agent |
| SQLite | Durable per-candidate memory inside Tensorlake MicroVM | `/tmp/larpbot_memory.db` |

## Getting started

### Prerequisites

- A Gmail account dedicated to the recruiting inbox
- A Google Cloud project with Gmail API + Cloud Pub/Sub enabled
- Tensorlake account, OpenAI API key, GitHub PAT
- Vercel project for the Next.js app

### Quick deploy

1. **Set Tensorlake secrets**:
   ```
   GITHUB_PAT, OPENAI_API_KEY, NIA_API_KEY,
   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
   ```
2. **Deploy the agent** — see `CLAUDE.md` for the full `uv` command.
3. **Deploy the Next.js app** to Vercel; set `TENSORLAKE_API_KEY` in env.
4. **Wire up Gmail push**: create a Pub/Sub topic, grant `gmail-api-push@system.gserviceaccount.com` Publisher role, create a push subscription pointed at `https://<your-vercel-domain>/api/gmail-webhook`.
5. **Register the watch** weekly (Gmail watches expire after 7 days):
   ```bash
   GMAIL_WATCH_TOPIC=projects/<gcp-project>/topics/gmail-watch \
     ... python agent/setup_gmail_watch.py
   ```

Send a test email with a GitHub URL — the report should arrive in under a minute.

## Project layout

```
agent/
  larpbot_agent.py        Single-file Tensorlake deployment.
                          Gmail / GitHub / OpenAI / SQLite logic all inlined.
  setup_gmail_watch.py    Registers Gmail push subscription. Run weekly.
  setup_cron.py           (Legacy) Tensorlake cron — broken upstream, unused.
  gmail_oauth_setup.py    One-time refresh-token bootstrapper.

app/
  api/analyze/            On-demand UI: kicks off a job
  api/status/[jobId]/     Poll endpoint for the UI
  api/gmail-webhook/      Pub/Sub push receiver (the real trigger)
  api/candidates/         Lists past candidates from Tensorlake memory

lib/
  openai.ts               GPT-4o agentic loop (mirrors the agent's loop)
  github.ts               GitHub REST client
  nia.ts                  Nia client (currently DNS-fails; non-fatal)
  types.ts                Canonical AnalysisResult shape
  jobStore.ts             In-memory UI job state

.github/workflows/poll.yml   Backup 5-min cron trigger.
public/demo.json             Offline fallback for the UI demo button.
```

## Known limitations

- Tensorlake's **built-in cron** fails with `internal_error` in milliseconds before any code runs — confirmed bug for this app. The Gmail Pub/Sub trigger is the supported path.
- **Nia API** (`api.nia.ai`) is unreachable from the Tensorlake runtime due to DNS failures. The agent falls back to GitHub-only verification tools and produces reports without it.
- **GitHub Actions schedules** are best-effort; the 5-minute backup cron may drift to 10–15 minutes during runner contention. It's a fallback, not the primary.
- **Gmail watch** expires every 7 days. Production should add a weekly cron to re-run `setup_gmail_watch.py`.

## License

Hackathon project. Use at your own risk.
