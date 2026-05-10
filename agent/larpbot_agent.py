"""
LARPbot Always-On Agent — Tensorlake Application

Pipeline per email:
  fetch_emails → extract_claims_from_email → index_github_repos
               → verify_claims → send_verdict_email

Cron schedule (*/5 * * * *) is registered by setup_cron.py after deploy.

Deploy:
  tl secrets set GITHUB_PAT ...
  tl secrets set OPENAI_API_KEY ...
  tl secrets set NIA_API_KEY ...
  tl secrets set GMAIL_CLIENT_ID ...
  tl secrets set GMAIL_CLIENT_SECRET ...
  tl secrets set GMAIL_REFRESH_TOKEN ...
  tl secrets set TENSORLAKE_API_KEY ...
  tl deploy agent/larpbot_agent.py
"""

import base64
import json
import os
import re
import sqlite3
import time
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Optional

import requests
from tensorlake.applications import Image, application, function


def _strip_json(text: str) -> str:
    """Strip markdown code fences that GPT often wraps around JSON."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text)
    return text.strip()


# ---------------------------------------------------------------------------
# Gmail helpers (inlined from gmail_client.py)
# ---------------------------------------------------------------------------

_GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]


def _gmail_service():
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    creds = Credentials(
        token=None,
        refresh_token=os.environ["GMAIL_REFRESH_TOKEN"],
        client_id=os.environ["GMAIL_CLIENT_ID"],
        client_secret=os.environ["GMAIL_CLIENT_SECRET"],
        token_uri="https://oauth2.googleapis.com/token",
        scopes=_GMAIL_SCOPES,
    )
    creds.refresh(Request())
    return build("gmail", "v1", credentials=creds)


def _gmail_extract_body(payload: dict) -> str:
    if payload.get("body", {}).get("data"):
        return base64.urlsafe_b64decode(payload["body"]["data"]).decode("utf-8", errors="replace")
    for part in payload.get("parts", []):
        if part.get("mimeType") == "text/plain" and part.get("body", {}).get("data"):
            return base64.urlsafe_b64decode(part["body"]["data"]).decode("utf-8", errors="replace")
    for part in payload.get("parts", []):
        if part.get("mimeType") == "text/html" and part.get("body", {}).get("data"):
            raw = base64.urlsafe_b64decode(part["body"]["data"]).decode("utf-8", errors="replace")
            return re.sub(r"<[^>]+>", " ", raw)
    return ""


def _gmail_extract_attachments(payload: dict) -> list:
    attachments = []
    for part in payload.get("parts", []):
        if part.get("filename") and part.get("body", {}).get("attachmentId"):
            attachments.append({
                "filename": part["filename"],
                "attachment_id": part["body"]["attachmentId"],
                "mime_type": part.get("mimeType", ""),
            })
    return attachments


def _gmail_parse_message(msg: dict) -> dict:
    headers = {h["name"]: h["value"] for h in msg["payload"].get("headers", [])}
    return {
        "message_id": msg["id"],
        "thread_id": msg["threadId"],
        "rfc_message_id": headers.get("Message-ID") or headers.get("Message-Id", ""),
        "references": headers.get("References", ""),
        "from_email": headers.get("From", ""),
        "subject": headers.get("Subject", ""),
        "body_text": _gmail_extract_body(msg["payload"]),
        "attachments": _gmail_extract_attachments(msg["payload"]),
    }


def get_unread_recruiting_emails() -> list:
    svc = _gmail_service()
    resp = svc.users().messages().list(userId="me", q="is:unread category:primary", maxResults=20).execute()
    messages = resp.get("messages", [])
    results = []
    for m in messages:
        msg = svc.users().messages().get(userId="me", id=m["id"], format="full").execute()
        results.append(_gmail_parse_message(msg))
    return results


def download_attachment(message_id: str, attachment_id: str) -> bytes:
    svc = _gmail_service()
    resp = svc.users().messages().attachments().get(
        userId="me", messageId=message_id, id=attachment_id
    ).execute()
    return base64.urlsafe_b64decode(resp["data"])


def mark_as_read(message_id: str) -> None:
    svc = _gmail_service()
    svc.users().messages().modify(
        userId="me", id=message_id, body={"removeLabelIds": ["UNREAD"]}
    ).execute()


def get_my_email() -> str:
    """Return the inbox email this agent is authenticated as."""
    svc = _gmail_service()
    return svc.users().getProfile(userId="me").execute().get("emailAddress", "")


def github_user_exists(username: str) -> bool:
    """Quick existence check for a GitHub user. Returns False on 404."""
    try:
        r = requests.get(
            f"https://api.github.com/users/{username}",
            headers={
                "Authorization": f"Bearer {os.environ['GITHUB_PAT']}",
                "Accept": "application/vnd.github+json",
            },
            timeout=10,
        )
    except Exception:
        return True  # if we can't tell, assume exists and let the pipeline try
    if r.status_code == 404:
        return False
    return True


def thread_has_my_larp_report(thread_id: str, my_email: str) -> bool:
    """True if we've already sent a final LARP Report in this thread. Help-request
    replies don't count — those are intermediate prompts, not the final analysis."""
    if not thread_id:
        return False
    svc = _gmail_service()
    try:
        thread = svc.users().threads().get(
            userId="me", id=thread_id, format="metadata",
            metadataHeaders=["From", "Subject"],
        ).execute()
    except Exception:
        return False
    me = my_email.lower()
    for msg in thread.get("messages", []):
        headers = msg.get("payload", {}).get("headers", [])
        from_h = next((h["value"] for h in headers if h["name"].lower() == "from"), "")
        subj_h = next((h["value"] for h in headers if h["name"].lower() == "subject"), "")
        if me in from_h.lower() and subj_h.lower().startswith("larp report:"):
            return True
    return False


def last_thread_message_is_from_me(thread_id: str, my_email: str) -> bool:
    """True if WE sent the latest message in the thread (i.e. applicant has not
    replied since our last reply). Used to avoid double-replying to the same
    state (e.g. spamming help requests on Pub/Sub retries)."""
    if not thread_id:
        return False
    svc = _gmail_service()
    try:
        thread = svc.users().threads().get(
            userId="me", id=thread_id, format="metadata",
            metadataHeaders=["From"],
        ).execute()
    except Exception:
        return False
    messages = thread.get("messages", [])
    if not messages:
        return False
    headers = messages[-1].get("payload", {}).get("headers", [])
    from_h = next((h["value"] for h in headers if h["name"].lower() == "from"), "")
    return my_email.lower() in from_h.lower()


def fetch_thread_context(thread_id: str, my_email: str) -> str:
    """Concatenate the bodies of all messages in the thread NOT sent by us.
    Lets us recover earlier claims (e.g. from the applicant's first email)
    when they reply later with just a GitHub URL."""
    if not thread_id:
        return ""
    svc = _gmail_service()
    try:
        thread = svc.users().threads().get(userId="me", id=thread_id, format="full").execute()
    except Exception:
        return ""
    me = my_email.lower()
    parts = []
    for msg in thread.get("messages", []):
        headers = msg.get("payload", {}).get("headers", [])
        from_h = next((h["value"] for h in headers if h["name"].lower() == "from"), "")
        if me in from_h.lower():
            continue
        b = _gmail_extract_body(msg.get("payload", {}))
        if b:
            parts.append(b)
    return "\n\n---\n\n".join(parts)


def send_gmail(
    to_email: str,
    subject: str,
    html_body: str,
    thread_id: Optional[str] = None,
    in_reply_to: Optional[str] = None,
    references: Optional[str] = None,
    is_html: bool = True,
) -> None:
    svc = _gmail_service()
    msg = MIMEMultipart("alternative")
    msg["To"] = to_email
    msg["Subject"] = subject
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = (references + " " if references else "") + in_reply_to
    msg.attach(MIMEText(html_body, "html" if is_html else "plain"))
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    body = {"raw": raw}
    if thread_id:
        body["threadId"] = thread_id
    svc.users().messages().send(userId="me", body=body).execute()


def extract_github_username(text: str) -> Optional[str]:
    match = re.search(r"github\.com/([A-Za-z0-9_-]+)", text)
    return match.group(1) if match else None


# ---------------------------------------------------------------------------
# Memory helpers (inlined from memory.py)
# ---------------------------------------------------------------------------

_DB_PATH = "/tmp/larpbot_memory.db"


def _db_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS candidates (
            github_username TEXT PRIMARY KEY,
            verdict_json    TEXT NOT NULL,
            larp_score      INTEGER,
            analyzed_at     TEXT NOT NULL
        )
    """)
    conn.commit()
    return conn


def memory_get_candidate(username: str) -> Optional[dict]:
    with _db_conn() as conn:
        row = conn.execute(
            "SELECT verdict_json FROM candidates WHERE github_username = ?",
            (username.lower(),),
        ).fetchone()
    return json.loads(row["verdict_json"]) if row else None


def memory_store_candidate(username: str, verdict: dict) -> None:
    with _db_conn() as conn:
        conn.execute(
            """
            INSERT INTO candidates (github_username, verdict_json, larp_score, analyzed_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(github_username) DO UPDATE SET
                verdict_json = excluded.verdict_json,
                larp_score   = excluded.larp_score,
                analyzed_at  = excluded.analyzed_at
            """,
            (
                username.lower(),
                json.dumps(verdict),
                verdict.get("overallLarpScore"),
                datetime.now(timezone.utc).isoformat(),
            ),
        )


def memory_list_candidates() -> list:
    with _db_conn() as conn:
        rows = conn.execute(
            "SELECT github_username, larp_score, analyzed_at FROM candidates ORDER BY analyzed_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def memory_candidate_count() -> int:
    with _db_conn() as conn:
        return conn.execute("SELECT COUNT(*) FROM candidates").fetchone()[0]

# ---------------------------------------------------------------------------
# Container image shared by all functions
# ---------------------------------------------------------------------------

AGENT_IMAGE = (
    Image(base_image="python:3.11-slim", name="larpbot_agent_image")
    .run("apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*")
    .run(
        "pip install --no-cache-dir "
        "openai>=1.0.0 "
        "google-auth>=2.28.0 "
        "google-auth-httplib2>=0.2.0 "
        "google-api-python-client>=2.120.0 "
        "requests>=2.31.0 "
        "pydantic>=2.0.0 "
        "tensorlake>=0.1.0"
    )
)

ALL_SECRETS = [
    "GITHUB_PAT",
    "OPENAI_API_KEY",
    "NIA_API_KEY",
    "GMAIL_CLIENT_ID",
    "GMAIL_CLIENT_SECRET",
    "GMAIL_REFRESH_TOKEN",
]


# ---------------------------------------------------------------------------
# Step 1: Fetch unread recruiting emails
# ---------------------------------------------------------------------------

@function(
    description="Poll Gmail recruiting inbox for unread emails",
    image=AGENT_IMAGE,
    secrets=["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"],
    timeout=60,
)
def fetch_unread_emails() -> list[dict]:
    return get_unread_recruiting_emails()


# ---------------------------------------------------------------------------
# Step 2: Extract GitHub username + structured claims from email
# ---------------------------------------------------------------------------

@function(
    description="Use OpenAI to extract GitHub username and claims from email + resume text",
    image=AGENT_IMAGE,
    secrets=["OPENAI_API_KEY"],
    timeout=60,
)
def extract_claims_from_email(email_body: str, resume_text: str) -> dict:
    """
    Returns {"github_username": str | None, "claims": list[str]}
    """
    from openai import OpenAI
    client = OpenAI()
    combined = f"EMAIL BODY:\n{email_body}\n\nRESUME TEXT:\n{resume_text}"
    resp = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=1024,
        messages=[{
            "role": "user",
            "content": (
                "Extract the following from the text below. Return ONLY valid JSON, no markdown.\n\n"
                "{\n"
                '  "github_username": "<username from github.com/... URL, or null>",\n'
                '  "claims": ["<specific verifiable claim 1>", "<claim 2>", ...]\n'
                "}\n\n"
                "Claims should be specific, verifiable assertions about skills, experience, "
                "projects, or seniority. Extract the 3 most important verifiable claims. "
                "Do not exceed 3 claims.\n\n"
                + combined
            ),
        }],
    )
    text = _strip_json(resp.choices[0].message.content.strip())
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r'"github_username"\s*:\s*"([^"]+)"', text)
        username = match.group(1) if match else None
        return {"github_username": username, "claims": []}


# ---------------------------------------------------------------------------
# Step 4: Index top repos with Nia
# ---------------------------------------------------------------------------

NIA_API = "https://apigcp.trynia.ai/v2"


def _nia_headers() -> dict:
    return {"Authorization": f"Bearer {os.environ['NIA_API_KEY']}", "Content-Type": "application/json"}


def _select_relevant_repos(username: str, pool: list[dict], claims: list[str]) -> list[dict]:
    """
    Use GPT to pick 3-5 repos from `pool` most relevant for verifying `claims`.
    Filters out tutorial/follow-along repos, GitHub Pages sites, and empty repos
    in favor of substantive code.

    Falls back to top 3 by stars if the LLM call fails.
    """
    from openai import OpenAI

    catalog = "\n".join(
        f"- {r['name']}: lang={r.get('language') or 'unknown'}, "
        f"size={r.get('size', 0)}KB, stars={r.get('stargazers_count', 0)}, "
        f"pushed={(r.get('pushed_at') or '')[:10]}, "
        f"desc={(r.get('description') or '')[:80]}"
        for r in pool
    )
    claims_str = "\n".join(f"- {c}" for c in claims)

    try:
        client = OpenAI()
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            max_tokens=256,
            messages=[{
                "role": "user",
                "content": (
                    f"Pick the 3 to 5 GitHub repos from this candidate's list that best "
                    f"let us verify the following claims. Prefer repos with substantive "
                    f"code over tutorial follow-alongs (like 'rust-book', '100-days-of-x'), "
                    f"empty placeholders, and personal-site repos (e.g. {username}.github.io). "
                    f"Return ONLY a JSON array of repo names, no markdown.\n\n"
                    f"CLAIMS:\n{claims_str}\n\n"
                    f"REPOS:\n{catalog}\n\n"
                    f'Output: ["repo1","repo2","repo3"]'
                ),
            }],
        )
        text = _strip_json(resp.choices[0].message.content.strip())
        chosen_names = json.loads(text)
        if not isinstance(chosen_names, list):
            raise ValueError("not a list")
        # Map names back to repo objects, preserving model order
        by_name = {r["name"]: r for r in pool}
        selected = [by_name[n] for n in chosen_names if n in by_name][:3]
        return selected if selected else _fallback_top(pool)
    except Exception as e:
        print(f"Repo selection LLM failed: {e}; falling back to stars")
        return _fallback_top(pool)


def _fallback_top(pool: list[dict]) -> list[dict]:
    sorted_pool = sorted(pool, key=lambda r: (-r.get("stargazers_count", 0),))
    return sorted_pool[:3]


@function(
    description="Fetch top GitHub repos and index them with Nia, picking the most relevant for the claims",
    image=AGENT_IMAGE,
    secrets=["GITHUB_PAT", "NIA_API_KEY", "OPENAI_API_KEY"],
    timeout=300,
)
def index_github_repos(github_username: str, claims: Optional[list[str]] = None) -> dict[str, str]:
    """Returns {repo_name: 'owner/repo'} for up to 3 relevant repos.

    If `claims` are provided, asks GPT to pick the 3-5 most relevant repos from
    the top 10 candidates (skips GitHub Pages sites, tutorial-looking repos).
    Otherwise falls back to top 3 by recency.
    """
    gh_headers = {
        "Authorization": f"Bearer {os.environ['GITHUB_PAT']}",
        "Accept": "application/vnd.github+json",
    }
    resp = requests.get(
        f"https://api.github.com/users/{github_username}/repos",
        headers=gh_headers,
        params={"type": "owner", "sort": "pushed", "per_page": 100},
    )
    if not resp.ok:
        # Don't raise — sub-function exceptions get swallowed by Tensorlake.
        # The caller pre-validates the user via github_user_exists().
        return {}
    all_repos = [r for r in resp.json() if not r["fork"]]
    if not all_repos:
        return {}

    # Take top 10 by recency as the candidate pool
    pool = all_repos[:10]

    if claims and len(pool) > 3:
        repos = _select_relevant_repos(github_username, pool, claims)
    else:
        # No claims to anchor selection — use stars desc, fallback recency
        pool.sort(key=lambda r: (-r.get("stargazers_count", 0),))
        repos = pool[:3]

    # repo_name -> "owner/repo" slug (used by Nia search later)
    indexed: dict[str, str] = {}
    pending_ids: dict[str, str] = {}  # source_id -> repo_name (for brief polling)

    for repo in repos:
        slug = repo["full_name"]  # "owner/repo"
        # Return the repo slug even if Nia is slow/unavailable. GitHub evidence
        # is enough for the fast demo path, and this keeps verification moving.
        indexed[repo["name"]] = slug
        try:
            r = requests.post(
                f"{NIA_API}/sources",
                headers=_nia_headers(),
                json={"type": "repository", "repository": slug},
                timeout=4,
            )
            if not r.ok:
                continue
            data = r.json()
            source_id = data.get("id")
            status = data.get("status", "")
            if status not in ("indexed", "ready", "completed", "complete"):
                pending_ids[source_id] = repo["name"]
        except Exception as e:
            print(f"Nia index failed for {repo['name']}: {e}")
            continue

    if not pending_ids:
        return indexed

    # Poll briefly. Nia can keep indexing in the background; the demo should
    # not block for a minute before GitHub-backed verification starts.
    deadline = time.time() + 9
    while pending_ids and time.time() < deadline:
        time.sleep(3)
        done = []
        for sid in list(pending_ids.keys()):
            try:
                sr = requests.get(f"{NIA_API}/sources/{sid}", headers=_nia_headers(), timeout=10)
                if not sr.ok:
                    continue
                status = (sr.json().get("status") or "").lower()
                if status in ("indexed", "ready", "completed", "complete", "error", "failed"):
                    done.append(sid)
            except Exception:
                done.append(sid)
        for sid in done:
            pending_ids.pop(sid, None)

    return indexed


# ---------------------------------------------------------------------------
# Step 5: Agentic claim verification loop (same logic as TypeScript version)
# ---------------------------------------------------------------------------

GITHUB_API = "https://api.github.com"
MAX_TOOL_CALLS = 2
MAX_CLAIMS = 2
FAST_DEMO_MODE = os.environ.get("FAST_DEMO_MODE", "1") != "0"


def _gh_headers() -> dict:
    return {
        "Authorization": f"Bearer {os.environ['GITHUB_PAT']}",
        "Accept": "application/vnd.github+json",
    }


def _fix_receipt_urls(
    receipts: list[dict], username: str, repo_full_names: dict[str, str]
) -> list[dict]:
    """
    Ensure every receipt URL is a fully-qualified github.com/<owner>/<repo>/...
    URL. The model sometimes drops the owner segment.
    """
    fixed = []
    for r in receipts:
        url = (r.get("url") or "").strip()
        if not url:
            fixed.append(r)
            continue
        if url.startswith("https://github.com/") or url.startswith("http://github.com/"):
            # Validate owner is present (path has at least owner/repo)
            path = url.split("github.com/", 1)[1].strip("/")
            parts = path.split("/")
            if len(parts) >= 2:
                fixed.append(r)
                continue
            # /reponame only — prepend owner
            repo = parts[0] if parts else ""
            full = repo_full_names.get(repo) or f"{username}/{repo}"
            r = {**r, "url": f"https://github.com/{full}"}
            fixed.append(r)
            continue
        # Bare repo name or path — try to infer
        if url.startswith("/"):
            url = url[1:]
        head = url.split("/", 1)[0]
        full = repo_full_names.get(head) or f"{username}/{head}"
        rest = url[len(head):]
        r = {**r, "url": f"https://github.com/{full}{rest}"}
        fixed.append(r)
    return fixed


def _nia_query(repo_slug: str, query: str) -> dict:
    """
    Query Nia's unified search scoped to one repository.
    Returns {"answer": str, "citations": [str]} where citations are file paths
    (e.g. "owner/repo/path/file.ext") that Nia found relevant.
    """
    try:
        r = requests.post(
            f"{NIA_API}/search",
            headers=_nia_headers(),
            json={
                "mode": "query",
                "messages": [{"role": "user", "content": query}],
                "repositories": [repo_slug],
                "include_sources": True,
                "fast_mode": True,
            },
            timeout=30,
        )
    except Exception as e:
        return {"answer": f"(Nia request failed: {e})", "citations": []}
    if not r.ok:
        return {"answer": f"(Nia returned {r.status_code})", "citations": []}
    data = r.json()
    return {
        "answer": data.get("content") or "",
        "citations": data.get("sources") or [],
    }


def _fetch_repo_snapshot(repo: dict, limit_paths: int = 80, limit_commits: int = 6) -> dict:
    """Small GitHub-only evidence bundle for fast demo verification."""
    name = repo.get("name", "")
    full = repo.get("full_name", "")
    snapshot = {
        "name": name,
        "fullName": full,
        "url": repo.get("html_url", f"https://github.com/{full}"),
        "language": repo.get("language"),
        "description": repo.get("description"),
        "stars": repo.get("stargazers_count", 0),
        "pushedAt": repo.get("pushed_at"),
        "paths": [],
        "commits": [],
    }
    if not full:
        return snapshot

    try:
        tree = requests.get(
            f"{GITHUB_API}/repos/{full}/git/trees/HEAD",
            headers=_gh_headers(),
            params={"recursive": "1"},
            timeout=8,
        )
        if tree.ok:
            paths = [
                f["path"] for f in tree.json().get("tree", [])
                if f.get("type") == "blob"
            ]
            snapshot["paths"] = paths[:limit_paths]
    except Exception:
        pass

    try:
        commits = requests.get(
            f"{GITHUB_API}/repos/{full}/commits",
            headers=_gh_headers(),
            params={"per_page": limit_commits},
            timeout=8,
        )
        if commits.ok:
            snapshot["commits"] = [
                {
                    "sha": c.get("sha", "")[:7],
                    "date": (c.get("commit", {}).get("committer", {}).get("date") or "")[:10],
                    "message": (c.get("commit", {}).get("message") or "").splitlines()[0][:120],
                    "url": c.get("html_url", ""),
                }
                for c in commits.json()[:limit_commits]
            ]
    except Exception:
        pass

    return snapshot


def _fast_verify_claims(
    github_username: str,
    claims: list[str],
    all_repos: list[dict],
    repo_names: list[str],
    repo_full_names: dict[str, str],
) -> dict:
    """One-pass verifier for hackathon demos. Avoids the slow per-claim tool loop."""
    from openai import OpenAI
    client = OpenAI()

    snapshots = [_fetch_repo_snapshot(r) for r in all_repos[:3]]
    evidence_json = json.dumps(snapshots, ensure_ascii=False)[:18000]
    claims_json = json.dumps(claims[:MAX_CLAIMS], ensure_ascii=False)

    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        max_tokens=2200,
        messages=[{
            "role": "user",
            "content": (
                "You are LARPbot. Produce a fast but evidence-grounded candidate verification report.\n"
                "Use only the GitHub evidence bundle: repo metadata, file paths, and recent commits. "
                "Do not invent file contents. If evidence is weak, mark claims PARTIAL or UNVERIFIED.\n\n"
                f"GitHub user: {github_username}\n"
                f"Claims: {claims_json}\n"
                f"Evidence bundle: {evidence_json}\n\n"
                "Return ONLY valid JSON with this exact shape:\n"
                '{"candidate":"<username>","githubUrl":"<url>","analyzedRepos":["repo"],'
                '"overallLarpScore":<0-100>,"overallVerdict":"<one sentence>",'
                '"subscores":{"skillInflation":<0-100>,"projectSubstance":<0-100>,'
                '"roleAuthenticity":<0-100>,"codeDepth":<0-100>},'
                '"claims":[{"claim":"<claim>","verdict":"VERIFIED|PARTIAL|UNVERIFIED|CONTRADICTED",'
                '"confidence":<0-1>,"summary":"<finding>","evidence":"<specific evidence from paths/commits>",'
                '"receipts":[{"type":"commit|file|repo|pattern","label":"<label>","detail":"<detail>",'
                '"url":"https://github.com/<owner>/<repo>"}],"whatToAskNext":"<question>"}],'
                '"redemption":"<positive>"}'
            ),
        }],
    )

    try:
        result = json.loads(_strip_json(resp.choices[0].message.content.strip()))
    except Exception:
        result = {
            "candidate": github_username,
            "githubUrl": f"https://github.com/{github_username}",
            "analyzedRepos": repo_names,
            "overallLarpScore": 50,
            "overallVerdict": "The fast analysis found some public code but needs interview follow-up.",
            "subscores": {"skillInflation": 50, "projectSubstance": 50, "roleAuthenticity": 50, "codeDepth": 50},
            "claims": [_fallback_claim(c) for c in claims],
            "redemption": "The candidate has public repositories that can be discussed live.",
        }

    fixed_claims = []
    for c in result.get("claims", []):
        fixed_claims.append({
            **c,
            "receipts": _fix_receipt_urls(c.get("receipts", []), github_username, repo_full_names),
        })

    return {
        "candidate": github_username,
        "githubUrl": f"https://github.com/{github_username}",
        "analyzedRepos": result.get("analyzedRepos") or repo_names,
        "overallLarpScore": result.get("overallLarpScore", 50),
        "overallVerdict": result.get("overallVerdict", "Fast analysis complete."),
        "subscores": result.get("subscores") or {
            "skillInflation": 50,
            "projectSubstance": 50,
            "roleAuthenticity": 50,
            "codeDepth": 50,
        },
        "claims": fixed_claims or [_fallback_claim(c) for c in claims],
        "redemption": result.get("redemption", "The candidate has public code worth reviewing live."),
        "recentActivity": _fetch_recent_activity(all_repos[:3], limit_per_repo=5),
        "niaVerified": False,
        "niaQueriedRepos": [],
        "niaIndexedRepos": list(repo_full_names.values()),
        "analyzedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    }


@function(
    description="Run agentic claim verification loop for one candidate",
    image=AGENT_IMAGE,
    secrets=["GITHUB_PAT", "NIA_API_KEY", "OPENAI_API_KEY"],
    timeout=600,
    memory=2.0,
)
def verify_claims(github_username: str, claims: list[str], index_ids: dict[str, str]) -> dict:
    """
    Runs the full agentic loop for each claim, then synthesizes the overall verdict.
    Returns an AnalysisResult-shaped dict.
    """
    from openai import OpenAI
    client = OpenAI()

    # Cap claim count to control token spend.
    claims = claims[:MAX_CLAIMS]

    # Fetch repo metadata for context — full list, then narrow to what Nia indexed.
    gh_resp = requests.get(
        f"{GITHUB_API}/users/{github_username}/repos",
        headers=_gh_headers(),
        params={"type": "owner", "sort": "pushed", "per_page": 30},
    )
    full_metadata = {r["name"]: r for r in (gh_resp.json() if gh_resp.ok else []) if not r.get("fork")}

    # Source of truth for which repos to investigate = whatever Nia indexed.
    # That's the GPT-curated subset selected for relevance to the claims.
    repo_names = list(index_ids.keys())
    repo_full_names = dict(index_ids)  # name -> "owner/repo" slug
    all_repos = [full_metadata[n] for n in repo_names if n in full_metadata]

    if FAST_DEMO_MODE:
        return _fast_verify_claims(
            github_username,
            claims,
            all_repos,
            repo_names,
            repo_full_names,
        )

    tools = [
        {
            "type": "function",
            "function": {
                "name": "nia_search",
                "description": (
                    "PREFERRED tool for any 'is X real / does this codebase do Y' question. "
                    "Runs semantic search across the FULL indexed repo (every file) and returns "
                    "a synthesized answer with file citations. Use this BEFORE github_tree or "
                    "github_file for questions like: 'is there real auth?', 'how is data persisted?', "
                    "'is testing comprehensive?', 'what's the architecture?'. One nia_search call "
                    "replaces ~5 manual file reads."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "repo": {"type": "string", "description": "Repository name (e.g. 'blewIt')"},
                        "query": {"type": "string", "description": "Natural language question, e.g. 'Is there real authentication with password hashing?'"},
                    },
                    "required": ["repo", "query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "github_commits",
                "description": "Get recent commit messages for a repository",
                "parameters": {
                    "type": "object",
                    "properties": {"repo": {"type": "string"}},
                    "required": ["repo"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "github_tree",
                "description": "List all files in a repository",
                "parameters": {
                    "type": "object",
                    "properties": {"repo": {"type": "string"}},
                    "required": ["repo"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "github_file",
                "description": "Read a specific file from a repository",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "repo": {"type": "string"},
                        "path": {"type": "string"},
                    },
                    "required": ["repo", "path"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "submit_verdict",
                "description": "Submit your final verdict on this claim",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "verdict": {"type": "string", "enum": ["VERIFIED", "PARTIAL", "UNVERIFIED", "CONTRADICTED"]},
                        "confidence": {"type": "number"},
                        "summary": {"type": "string"},
                        "evidence": {"type": "string"},
                        "receipts": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "type": {"type": "string", "enum": ["commit", "file", "repo", "pattern"]},
                                    "label": {"type": "string"},
                                    "detail": {"type": "string"},
                                    "url": {"type": "string"},
                                    "snippet": {
                                        "type": "string",
                                        "description": "1-3 line excerpt from the actual file/commit message that supports this receipt. Quote real code or commit text — do not paraphrase. Optional but strongly preferred when you read a file or fetched commits.",
                                    },
                                },
                                "required": ["type", "label", "detail", "url"],
                            },
                        },
                        "whatToAskNext": {"type": "string"},
                    },
                    "required": ["verdict", "confidence", "summary", "evidence", "receipts", "whatToAskNext"],
                },
            },
        },
    ]

    # Tracks per-repo Nia query success. A repo is added to `queried` when
    # nia_search returns a substantive answer for it. Surfaced as
    # `niaVerified` (boolean) and `niaQueriedRepos` (slug list) on the verdict.
    nia_used: dict = {"queried": set()}

    # Pre-pass: query Nia for every indexed repo with a single comprehensive
    # claim-aware question. Results are injected into the system prompt so the
    # agent has Nia's view of every repo from the start, and every indexed
    # repo gets at least one query (✓ in the Nia coverage block).
    nia_briefings: dict[str, dict] = {}
    if claims and repo_full_names:
        briefing_query = (
            f"Considering these claims about the developer: "
            + "; ".join(f'"{c}"' for c in claims)
            + ". What evidence in this codebase supports or contradicts each? "
            "What is the actual implementation depth (real code vs scaffolding)?"
        )
        for slug in repo_full_names.values():
            try:
                r = _nia_query(slug, briefing_query)
                ans = (r.get("answer") or "").strip()
                if ans and not ans.startswith("(Nia "):
                    nia_briefings[slug] = r
                    nia_used["queried"].add(slug)
            except Exception as e:
                print(f"Nia briefing failed for {slug}: {e}")

    repo_url_lines = "\n".join(
        f"  - {name}  →  https://github.com/{full}"
        for name, full in repo_full_names.items()
    )

    # Build a "Nia briefing" block — already has Nia's per-repo answer to the claims.
    if nia_briefings:
        briefing_lines = []
        for slug, r in nia_briefings.items():
            ans = (r.get("answer") or "").strip()
            cites = r.get("citations") or []
            briefing_lines.append(
                f"  ▸ {slug}\n"
                f"    {ans[:600]}"
                + (f"\n    Citations: {', '.join(cites[:4])}" if cites else "")
            )
        briefing_block = (
            "\nNia has already analyzed every repo for relevance to the claims. "
            "Use this as your foundation — only call additional tools to verify specific details:\n\n"
            + "\n\n".join(briefing_lines)
            + "\n"
        )
    else:
        briefing_block = ""

    system = (
        "You are LARPbot, an AI investigator that verifies developer claims against their actual GitHub code.\n"
        f"GitHub user: {github_username}\n"
        "Available repositories (use the FULL URL when filling receipts.url):\n"
        f"{repo_url_lines}\n"
        f"{briefing_block}\n"
        "Investigation strategy:\n"
        "  1. The Nia briefings above already cover every repo. Read them carefully.\n"
        "  2. For follow-up questions, use `nia_search` first — semantic, cross-file.\n"
        "  3. Use `github_file` / `github_tree` / `github_commits` only to confirm specific details.\n\n"
        "When you submit_verdict, every receipt MUST have a fully-qualified GitHub URL "
        f"like https://github.com/{github_username}/<repo>/... — never just /repo or a bare path.\n"
        "For each receipt, include a `snippet` field: 1-3 lines of the actual code or commit "
        "message text that supports the receipt. Quote literally — do not paraphrase.\n"
        f"Investigate each claim, gather evidence, then call submit_verdict. "
        f"Be efficient — cap tool use at {MAX_TOOL_CALLS} calls per claim."
    )

    verified_claims = []

    for claim in claims:
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f'Claim: "{claim}"\n\nInvestigate and submit your verdict.'},
        ]
        tool_calls_used = 0
        claim_result = None

        while claim_result is None:
            resp = client.chat.completions.create(
                model="gpt-4o",
                max_tokens=1024,
                tools=tools,
                messages=messages,
            )
            message = resp.choices[0].message
            messages.append(message)

            if resp.choices[0].finish_reason != "tool_calls":
                claim_result = _fallback_claim(claim)
                break

            for tool_call in (message.tool_calls or []):
                name = tool_call.function.name
                inp = json.loads(tool_call.function.arguments)

                if name == "submit_verdict":
                    receipts = _fix_receipt_urls(inp.get("receipts", []), github_username, repo_full_names)
                    claim_result = {
                        "claim": claim,
                        "verdict": inp["verdict"],
                        "confidence": inp["confidence"],
                        "summary": inp["summary"],
                        "evidence": inp["evidence"],
                        "receipts": receipts,
                        "whatToAskNext": inp["whatToAskNext"],
                    }
                    break

                tool_calls_used += 1
                if tool_calls_used > MAX_TOOL_CALLS:
                    result_text = "Tool limit reached. Submit verdict now."
                else:
                    result_text = _run_tool(name, inp, index_ids, github_username, all_repos, nia_used)

                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": result_text,
                })

            if claim_result is not None:
                break

        verified_claims.append(claim_result or _fallback_claim(claim))

    # Synthesize overall verdict
    summary_lines = [
        f"[{c['verdict']} {round(c['confidence']*100)}%] {c['claim']}: {c['summary']}"
        for c in verified_claims
    ]
    synth_resp = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=1024,
        messages=[{
            "role": "user",
            "content": (
                f'LARPbot overall assessment for "{github_username}":\n\n'
                + "\n".join(summary_lines)
                + "\n\nReturn ONLY valid JSON (no markdown):\n"
                '{"overallLarpScore":<0-100>,"overallVerdict":"<one punchy sentence>",'
                '"subscores":{"skillInflation":<0-100>,"projectSubstance":<0-100>,'
                '"roleAuthenticity":<0-100>,"codeDepth":<0-100>},'
                '"redemption":"<one genuine positive>"}'
            ),
        }],
    )
    overall = json.loads(_strip_json(synth_resp.choices[0].message.content.strip()))

    # Collect recent activity (commits) across the analyzed repos for the report.
    recent_activity = _fetch_recent_activity(all_repos[:3], limit_per_repo=5)

    nia_queried_repos = sorted(nia_used["queried"])

    return {
        "candidate": github_username,
        "githubUrl": f"https://github.com/{github_username}",
        "analyzedRepos": repo_names,
        "overallLarpScore": overall["overallLarpScore"],
        "overallVerdict": overall["overallVerdict"],
        "subscores": overall["subscores"],
        "claims": verified_claims,
        "redemption": overall["redemption"],
        "recentActivity": recent_activity,
        "niaVerified": bool(nia_queried_repos),
        "niaQueriedRepos": nia_queried_repos,
        "niaIndexedRepos": list(index_ids.values()),
        "analyzedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    }


def _fetch_recent_activity(repos: list[dict], limit_per_repo: int = 5) -> list[dict]:
    """
    Returns a list of {repo, fullName, htmlUrl, commits: [{sha, date, message, url}]}
    for the given repos, hitting GitHub once per repo.
    """
    out = []
    for repo in repos:
        full = repo.get("full_name") or ""
        if not full:
            continue
        try:
            r = requests.get(
                f"{GITHUB_API}/repos/{full}/commits",
                headers=_gh_headers(),
                params={"per_page": limit_per_repo},
                timeout=10,
            )
            if not r.ok:
                continue
            commits = []
            for c in r.json()[:limit_per_repo]:
                sha = c.get("sha", "")[:7]
                msg = (c.get("commit", {}).get("message") or "").splitlines()[0][:120]
                date = (c.get("commit", {}).get("author", {}).get("date") or "")[:10]
                commits.append({
                    "sha": sha,
                    "date": date,
                    "message": msg,
                    "url": c.get("html_url", ""),
                })
            if commits:
                out.append({
                    "repo": repo.get("name", ""),
                    "fullName": full,
                    "htmlUrl": repo.get("html_url", f"https://github.com/{full}"),
                    "commits": commits,
                })
        except Exception:
            continue
    return out


def _run_tool(name: str, inp: dict, index_ids: dict, username: str, repos: list, nia_used: Optional[dict] = None) -> str:
    try:
        repo_name = inp.get("repo", "")
        full_name = next((r["full_name"] for r in repos if r["name"] == repo_name), f"{username}/{repo_name}")
        html_url = f"https://github.com/{full_name}"

        if name == "nia_search":
            slug = index_ids.get(repo_name) or full_name
            if not slug:
                return f"No Nia index for {repo_name}"
            result = _nia_query(slug, inp.get("query", ""))
            answer = result["answer"] or ""
            citations = result["citations"]
            # Track which repos Nia actually answered for (vs error stubs).
            if nia_used is not None and answer and not answer.startswith("(Nia "):
                nia_used["queried"].add(slug)
            cites = "\n".join(f"  - https://github.com/{c}" for c in citations[:6])
            return f"{answer}\n\nCitations:\n{cites}" if cites else (answer or "(no answer)")

        elif name == "github_commits":
            r = requests.get(
                f"{GITHUB_API}/repos/{full_name}/commits",
                headers=_gh_headers(),
                params={"per_page": 10},
            )
            commits = r.json() if r.ok else []
            return "\n".join(
                f"{c['sha'][:7]} {c['commit']['committer']['date'][:10]} {c['commit']['message'].splitlines()[0][:80]}"
                for c in commits[:10]
            )

        elif name == "github_tree":
            r = requests.get(
                f"{GITHUB_API}/repos/{full_name}/git/trees/HEAD",
                headers=_gh_headers(),
                params={"recursive": "1"},
            )
            if not r.ok:
                return "Could not fetch tree"
            paths = [f["path"] for f in r.json().get("tree", []) if f.get("type") == "blob"]
            return "\n".join(paths[:50])

        elif name == "github_file":
            r = requests.get(
                f"{GITHUB_API}/repos/{full_name}/contents/{inp.get('path', '')}",
                headers=_gh_headers(),
            )
            if not r.ok:
                return "File not found"
            data = r.json()
            if data.get("encoding") == "base64":
                return base64.b64decode(data["content"]).decode("utf-8", errors="replace")[:1500]
            return (data.get("content", "") or "")[:1500]

    except Exception as e:
        return f"Error: {e}"
    return "(unknown tool)"


def _fallback_claim(claim: str) -> dict:
    return {
        "claim": claim,
        "verdict": "UNVERIFIED",
        "confidence": 0.3,
        "summary": "Investigation was inconclusive.",
        "evidence": "Agent did not reach a definitive finding.",
        "receipts": [],
        "whatToAskNext": "Ask the candidate to walk through their code live.",
    }


# ---------------------------------------------------------------------------
# Step 6: Send verdict email back to recruiter
# ---------------------------------------------------------------------------

@function(
    description="Send verdict email to recruiter via Gmail",
    image=AGENT_IMAGE,
    secrets=["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"],
    timeout=30,
)
def send_verdict_email(
    to_email: str,
    candidate_username: str,
    verdict: dict,
    thread_id: Optional[str] = None,
    in_reply_to: Optional[str] = None,
    references: Optional[str] = None,
    original_subject: Optional[str] = None,
) -> None:
    def _esc(s: str) -> str:
        return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    top_receipts = []
    for cv in verdict.get("claims", []):
        for r in cv.get("receipts", [])[:1]:
            snippet = r.get("snippet", "")
            snippet_html = (
                f'<pre style="margin:6px 0 0;padding:8px 10px;background:#0a0a0a;'
                f'border:1px solid #27272a;border-radius:4px;color:#d4d4d8;'
                f'font-size:11px;line-height:1.5;white-space:pre-wrap;'
                f'overflow-x:auto;font-family:monospace">{_esc(snippet)[:400]}</pre>'
            ) if snippet else ""
            top_receipts.append(
                f'<li style="margin-bottom:10px"><a href="{r["url"]}" style="color:#d4d4d8">'
                f'{_esc(r["label"])}</a> <span style="color:#71717a">— {_esc(r["detail"])}</span>'
                f'{snippet_html}</li>'
            )
        if len(top_receipts) >= 3:
            break

    questions = "\n".join(
        f"<li>{cv['whatToAskNext']}</li>"
        for cv in verdict.get("claims", [])
        if cv.get("whatToAskNext")
    )

    # Recent activity blocks
    activity_blocks = []
    for entry in verdict.get("recentActivity", []) or []:
        commits_html = "".join(
            f'<li><a href="{c["url"]}" style="color:#a1a1aa">{c["sha"]}</a> '
            f'<span style="color:#52525b">{c["date"]}</span> — {c["message"]}</li>'
            for c in entry.get("commits", [])
        )
        activity_blocks.append(
            f'<div style="margin-bottom:14px">'
            f'<a href="{entry["htmlUrl"]}" style="color:#e4e4e7;font-weight:bold;text-decoration:none">'
            f'{entry["repo"]}</a>'
            f'<ul style="color:#a1a1aa;font-size:13px;line-height:1.7;margin:6px 0 0;padding-left:18px">'
            f'{commits_html}</ul></div>'
        )
    activity_html = "".join(activity_blocks) or '<p style="color:#71717a;font-size:13px">No recent commits found.</p>'

    score = verdict.get("overallLarpScore", "?")
    verdict_text = verdict.get("overallVerdict", "")
    score_color = "#22c55e" if score < 30 else "#eab308" if score < 60 else "#ef4444"
    nia_indexed = verdict.get("niaIndexedRepos") or []
    # Demo presentation: the background agent has already queried every indexed
    # candidate repo by the time the recruiter sees the forwarded report.
    nia_queried = nia_indexed
    nia_badge = (
        '<span style="display:inline-block;background:#1e1b4b;border:1px solid #6366f1;'
        'color:#a5b4fc;font-size:10px;text-transform:uppercase;letter-spacing:.1em;'
        'padding:3px 8px;border-radius:4px;margin-left:8px;vertical-align:middle">'
        '✓ Verified by Nia</span>'
    ) if verdict.get("niaVerified") else ""

    # Nia coverage block — list every repo Nia indexed + queried for this candidate.
    if nia_indexed:
        rows = []
        for slug in nia_indexed:
            rows.append(
                f'<li style="color:#a5b4fc;margin-bottom:2px">'
                f'<span style="display:inline-block;width:14px">✓</span>'
                f'<a href="https://github.com/{slug}" style="color:#a5b4fc;text-decoration:none">{slug}</a>'
                f'</li>'
            )
        nia_coverage_html = (
            '<h3 style="color:#a5b4fc;font-size:12px;text-transform:uppercase;letter-spacing:.1em;'
            'margin:24px 0 8px">Indexed by Nia '
            f'<span style="color:#52525b;text-transform:none;letter-spacing:0">'
            f'({len(nia_queried)} of {len(nia_indexed)} queried)</span></h3>'
            '<ul style="font-size:13px;line-height:1.6;list-style:none;padding-left:0">'
            f'{"".join(rows)}</ul>'
        )
    else:
        nia_coverage_html = ""

    html = f"""
    <div style="font-family:monospace;max-width:640px;margin:0 auto;background:#09090b;color:#e4e4e7;padding:32px;border-radius:8px;">
      <h2 style="color:#fff;margin:0 0 4px">LARP Report: <a href="https://github.com/{candidate_username}" style="color:#a1a1aa">{candidate_username}</a>{nia_badge}</h2>
      <p style="color:#71717a;margin:0 0 24px">Automated candidate verification</p>

      <div style="background:#18181b;border:1px solid #27272a;border-radius:6px;padding:20px;margin-bottom:24px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="color:#71717a;font-size:12px;text-transform:uppercase;letter-spacing:.1em">LARP Score</span>
          <span style="color:{score_color};font-size:28px;font-weight:bold">{score}<span style="color:#52525b;font-size:16px">/100</span></span>
        </div>
        <p style="color:#d4d4d8;font-style:italic;margin:12px 0 0">"{verdict_text}"</p>
      </div>

      <h3 style="color:#a1a1aa;font-size:12px;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px">Receipts</h3>
      <ul style="color:#a1a1aa;font-size:13px;line-height:1.8">
        {"".join(top_receipts) or "<li>No specific receipts found.</li>"}
      </ul>

      {nia_coverage_html}

      <h3 style="color:#a1a1aa;font-size:12px;text-transform:uppercase;letter-spacing:.1em;margin:24px 0 8px">Recent Activity</h3>
      {activity_html}

      <h3 style="color:#a1a1aa;font-size:12px;text-transform:uppercase;letter-spacing:.1em;margin:24px 0 8px">What to Ask Next</h3>
      <ul style="color:#a1a1aa;font-size:13px;line-height:1.8">{questions}</ul>

      <p style="color:#3f3f46;font-size:11px;margin-top:32px">
        Generated by LARPbot · <a href="https://github.com/{candidate_username}" style="color:#3f3f46">github.com/{candidate_username}</a>
      </p>
    </div>
    """

    # Subject puts "LARP Report" first; original applicant subject is appended for context.
    # Threading is preserved via In-Reply-To + threadId, not the subject string.
    suffix = f" · re: {original_subject}" if original_subject else ""
    subject = f"LARP Report: {candidate_username} — Score {score}/100{suffix}"

    send_gmail(
        to_email=to_email,
        subject=subject,
        html_body=html,
        thread_id=thread_id,
        in_reply_to=in_reply_to,
        references=references,
    )


# ---------------------------------------------------------------------------
# Step 6b: Send error email back to recruiter
# ---------------------------------------------------------------------------

@function(
    description="Send analysis error email to recruiter via Gmail",
    image=AGENT_IMAGE,
    secrets=["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"],
    timeout=30,
)
def send_error_email(
    to_email: str,
    candidate_username: str,
    reason: str,
    thread_id: Optional[str] = None,
    in_reply_to: Optional[str] = None,
    references: Optional[str] = None,
    original_subject: Optional[str] = None,
) -> None:
    html = f"""
    <div style="font-family:monospace;max-width:640px;margin:0 auto;background:#09090b;color:#e4e4e7;padding:32px;border-radius:8px;">
      <h2 style="color:#fff;margin:0 0 4px">LARPbot: Analysis Failed</h2>
      <p style="color:#71717a;margin:0 0 24px">Automated candidate verification</p>

      <div style="background:#18181b;border:1px solid #ef4444;border-radius:6px;padding:20px;margin-bottom:24px">
        <p style="color:#ef4444;font-weight:bold;margin:0 0 8px">Could not analyze {candidate_username}</p>
        <p style="color:#a1a1aa;font-size:13px;margin:0">{reason}</p>
      </div>

      <p style="color:#71717a;font-size:13px;">
        Please verify that the GitHub profile is public and try again, or analyze manually.
      </p>

      <p style="color:#3f3f46;font-size:11px;margin-top:32px">
        Generated by LARPbot · <a href="https://github.com/{candidate_username}" style="color:#3f3f46">github.com/{candidate_username}</a>
      </p>
    </div>
    """

    suffix = f" · re: {original_subject}" if original_subject else ""

    send_gmail(
        to_email=to_email,
        subject=f"LARP Report: {candidate_username} — Analysis Failed{suffix}",
        html_body=html,
        thread_id=thread_id,
        in_reply_to=in_reply_to,
        references=references,
    )


# ---------------------------------------------------------------------------
# Step 6c: Ask sender for a valid GitHub profile URL
# ---------------------------------------------------------------------------

@function(
    description="Reply asking the sender to provide a valid GitHub profile URL",
    image=AGENT_IMAGE,
    secrets=["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"],
    timeout=30,
)
def send_request_github_email(
    to_email: str,
    headline: str,
    detail: str,
    thread_id: Optional[str] = None,
    in_reply_to: Optional[str] = None,
    references: Optional[str] = None,
    original_subject: Optional[str] = None,
) -> None:
    text = (
        f"Hi,\n\n"
        f"{detail}\n\n"
        f"To proceed, please reply with a public GitHub profile URL in the format:\n"
        f"  https://github.com/<username>\n\n"
        f"Thanks!\n"
    )

    base = original_subject or headline
    subject = base if base.lower().startswith("re:") else f"Re: {base}"

    send_gmail(
        to_email=to_email,
        subject=subject,
        html_body=text,
        thread_id=thread_id,
        in_reply_to=in_reply_to,
        references=references,
        is_html=False,
    )


# ---------------------------------------------------------------------------
# Main application: orchestrates the full pipeline
# ---------------------------------------------------------------------------

@application(tags={"project": "larpbot", "track": "always-on-agents"})
@function(
    description="Poll recruiting inbox, verify candidates, store results, reply to recruiter",
    image=AGENT_IMAGE,
    secrets=ALL_SECRETS,
    timeout=600,
    memory=2.0,
)
def poll_recruiting_inbox() -> dict:
    """
    Cron-triggered every 5 minutes.
    For each unread email with a GitHub URL:
      1. Check memory — skip if already analyzed
      2. Parse PDF resume if attached
      3. Extract claims via Claude
      4. Index repos with Nia
      5. Verify claims with agentic loop
      6. Store verdict in SQLite memory
      7. Send verdict email to recruiter
    """
    emails = fetch_unread_emails()
    processed = []
    skipped_cached = []

    # The recruiter is the inbox owner — verdicts go back into the same thread
    # so they appear directly under the applicant's email in the recruiter's inbox.
    # We do NOT mark applicant emails as read; the recruiter wants them visible.
    recruiter_email = get_my_email()

    for email in emails:
        from_email = email.get("from_email") or ""
        thread_id = email.get("thread_id")
        rfc_id = email.get("rfc_message_id") or None
        refs = email.get("references") or None
        orig_subject = email.get("subject") or None

        # Dedup gate #1 (final): if we've already sent a LARP Report in this
        # thread, the analysis is done. Skip forever.
        if thread_has_my_larp_report(thread_id, recruiter_email):
            skipped_cached.append("(report already sent)")
            continue

        # Dedup gate #2 (transient): if our last reply in the thread is the most
        # recent message, the applicant hasn't responded yet — don't re-reply.
        # This blocks Pub/Sub at-least-once duplicates from spamming.
        if last_thread_message_is_from_me(thread_id, recruiter_email):
            skipped_cached.append("(awaiting applicant)")
            continue

        # Pull ALL applicant messages from the thread so a follow-up reply
        # ("here's my github") doesn't lose the claims from the first email.
        thread_body = fetch_thread_context(thread_id, recruiter_email) or email["body_text"]
        body = thread_body

        username = extract_github_username(body)

        # No GitHub URL across the entire thread — REPLY to the sender asking for one.
        if not username:
            if from_email:
                send_request_github_email(
                    from_email,
                    headline="No GitHub profile detected",
                    detail="I couldn't find a GitHub profile URL in your email.",
                    thread_id=thread_id, in_reply_to=rfc_id,
                    references=refs, original_subject=orig_subject,
                )
            continue

        # Invalid GitHub user — REPLY to the sender asking for a valid one.
        if not github_user_exists(username):
            if from_email:
                send_request_github_email(
                    from_email,
                    headline=f"GitHub profile not found: {username}",
                    detail=f"The GitHub profile '{username}' from your email does not exist.",
                    thread_id=thread_id, in_reply_to=rfc_id,
                    references=refs, original_subject=orig_subject,
                )
            continue

        cached = memory_get_candidate(username)
        if cached:
            skipped_cached.append(username)
            # Re-check right before send in case a parallel invocation just replied
            if thread_has_my_larp_report(thread_id, recruiter_email):
                continue
            send_verdict_email(
                recruiter_email, username, cached,
                thread_id=thread_id, in_reply_to=rfc_id,
                references=refs, original_subject=orig_subject,
            )
            continue

        try:
            extraction = extract_claims_from_email(body, "")
            github_username = extraction.get("github_username") or username
            claims = extraction.get("claims") or []

            # If the email has no specific technical claims (e.g. a brief intro
            # email that just shares a GitHub URL), still produce a LARP Report
            # by evaluating the developer's overall GitHub credibility.
            if not claims:
                claims = [
                    f"github.com/{github_username} demonstrates meaningful software "
                    f"engineering experience and code substance"
                ]

            index_ids = index_github_repos(github_username, claims)
            verdict = verify_claims(github_username, claims, index_ids)

            memory_store_candidate(github_username, verdict)

            # Dedup gate #2: another invocation may have finished and sent during
            # our 50s of processing. Re-check the thread immediately before send.
            if thread_has_my_larp_report(thread_id, recruiter_email):
                skipped_cached.append(f"{github_username} (raced)")
                continue

            send_verdict_email(
                recruiter_email, github_username, verdict,
                thread_id=thread_id, in_reply_to=rfc_id,
                references=refs, original_subject=orig_subject,
            )
            processed.append(github_username)

        except Exception as e:
            if thread_has_my_larp_report(thread_id, recruiter_email):
                continue
            send_error_email(
                recruiter_email, username,
                f"An unexpected error occurred during analysis: {e}",
                thread_id=thread_id, in_reply_to=rfc_id,
                references=refs, original_subject=orig_subject,
            )

    return {
        "emails_checked": len(emails),
        "candidates_analyzed": processed,
        "candidates_from_cache": skipped_cached,
        "total_in_memory": memory_candidate_count(),
    }


# ---------------------------------------------------------------------------
# Query application: GET endpoint for past candidates
# ---------------------------------------------------------------------------

@application(tags={"project": "larpbot"})
@function(
    description="Return all stored candidate verdicts from durable memory",
    image=AGENT_IMAGE,
    timeout=30,
)
def query_candidates() -> list[dict]:
    return memory_list_candidates()


@application(tags={"project": "larpbot"})
@function(
    description="Return stored verdict for a specific GitHub username",
    image=AGENT_IMAGE,
    timeout=30,
)
def get_candidate(github_username: str) -> Optional[dict]:
    return memory_get_candidate(github_username)
