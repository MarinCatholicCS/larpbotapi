"""
LARPbot Always-On Agent — Tensorlake Application

Pipeline per email:
  fetch_emails → extract_claims_from_email → index_github_repos
               → verify_claims → send_verdict_email

Cron schedule (*/5 * * * *) is registered by setup_cron.py after deploy.

Deploy:
  tl secrets set GITHUB_PAT ...
  tl secrets set ANTHROPIC_API_KEY ...
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
import time
from typing import Optional

from openai import OpenAI
import requests
from pydantic import BaseModel
from tensorlake.applications import Image, application, function
from tensorlake.documentai import ChunkingStrategy, DocumentAI, ParsingOptions

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
    from gmail_client import get_unread_recruiting_emails
    return get_unread_recruiting_emails()


# ---------------------------------------------------------------------------
# Step 2: Parse a PDF resume attachment via Tensorlake Document AI
# ---------------------------------------------------------------------------

@function(
    description="Parse PDF resume bytes and return extracted text",
    image=AGENT_IMAGE,
    secrets=["TENSORLAKE_API_KEY"],
    timeout=120,
)
def parse_resume_pdf(pdf_bytes_b64: str) -> str:
    """Upload PDF to Tensorlake Document AI and extract text."""
    import tempfile, os as _os
    pdf_bytes = base64.b64decode(pdf_bytes_b64)
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(pdf_bytes)
        tmp_path = f.name
    try:
        doc_ai = DocumentAI()
        parse_id = doc_ai.read(
            file_path=tmp_path,
            parsing_options=ParsingOptions(chunking_strategy=ChunkingStrategy.PAGE),
        )
        result = doc_ai.wait_for_completion(parse_id)
        return "\n\n".join(c.content for c in result.chunks)
    finally:
        _os.unlink(tmp_path)


# ---------------------------------------------------------------------------
# Step 3: Extract GitHub username + structured claims from email + resume text
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
                "projects, or seniority. Extract 3–6 claims.\n\n"
                + combined
            ),
        }],
    )
    text = resp.choices[0].message.content.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r'"github_username"\s*:\s*"([^"]+)"', text)
        username = match.group(1) if match else None
        return {"github_username": username, "claims": []}


# ---------------------------------------------------------------------------
# Step 4: Index top repos with Nia
# ---------------------------------------------------------------------------

NIA_API = "https://api.nia.ai/v1"


def _nia_headers() -> dict:
    return {"Authorization": f"Bearer {os.environ['NIA_API_KEY']}", "Content-Type": "application/json"}


@function(
    description="Fetch top GitHub repos and index them with Nia",
    image=AGENT_IMAGE,
    secrets=["GITHUB_PAT", "NIA_API_KEY"],
    timeout=300,
)
def index_github_repos(github_username: str) -> dict[str, str]:
    """Returns {repo_name: nia_index_id} for up to 3 repos."""
    gh_headers = {
        "Authorization": f"Bearer {os.environ['GITHUB_PAT']}",
        "Accept": "application/vnd.github+json",
    }
    resp = requests.get(
        f"https://api.github.com/users/{github_username}/repos",
        headers=gh_headers,
        params={"type": "owner", "sort": "pushed", "per_page": 100},
    )
    resp.raise_for_status()
    repos = [r for r in resp.json() if not r["fork"]]
    repos.sort(key=lambda r: (-r["stargazers_count"],))
    repos = repos[:3]

    index_ids: dict[str, str] = {}
    for repo in repos:
        clone_url = repo["clone_url"]
        r = requests.post(NIA_API + "/indexes", headers=_nia_headers(), json={"url": clone_url})
        if not r.ok:
            continue
        index_id = r.json().get("id") or r.json().get("indexId") or r.json().get("index_id")
        if not index_id:
            continue
        index_ids[repo["name"]] = index_id

    # Poll until all ready (max 90s)
    deadline = time.time() + 90
    pending = set(index_ids.values())
    while pending and time.time() < deadline:
        time.sleep(3)
        done = set()
        for idx_id in list(pending):
            sr = requests.get(f"{NIA_API}/indexes/{idx_id}", headers=_nia_headers())
            if not sr.ok:
                continue
            status = sr.json().get("status") or sr.json().get("state") or ""
            if status in ("ready", "complete", "completed"):
                done.add(idx_id)
            elif status in ("error", "failed"):
                done.add(idx_id)
        pending -= done

    return index_ids


# ---------------------------------------------------------------------------
# Step 5: Agentic claim verification loop (same logic as TypeScript version)
# ---------------------------------------------------------------------------

GITHUB_API = "https://api.github.com"
MAX_TOOL_CALLS = 8


def _gh_headers() -> dict:
    return {
        "Authorization": f"Bearer {os.environ['GITHUB_PAT']}",
        "Accept": "application/vnd.github+json",
    }


def _nia_query(index_id: str, query: str, top_k: int = 5) -> list[dict]:
    r = requests.post(
        f"{NIA_API}/indexes/{index_id}/query",
        headers=_nia_headers(),
        json={"query": query, "top_k": top_k},
    )
    if not r.ok:
        return []
    data = r.json()
    results = data.get("results") or data.get("snippets") or data.get("chunks") or []
    return [
        {
            "content": s.get("content") or s.get("text") or "",
            "filePath": s.get("file_path") or s.get("filePath") or s.get("path") or "",
        }
        for s in results
    ]


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
    client = OpenAI()

    # Fetch repo metadata for context
    gh_resp = requests.get(
        f"{GITHUB_API}/users/{github_username}/repos",
        headers=_gh_headers(),
        params={"type": "owner", "sort": "pushed", "per_page": 10},
    )
    all_repos = [r for r in (gh_resp.json() if gh_resp.ok else []) if not r.get("fork")]
    repo_names = [r["name"] for r in all_repos[:3]]

    tools = [
        {
            "type": "function",
            "function": {
                "name": "nia_search",
                "description": "Search the indexed codebase for relevant code snippets",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "repo": {"type": "string", "description": "Repository name"},
                        "query": {"type": "string", "description": "Natural language search query"},
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

    system = (
        f"You are LARPbot, an AI investigator that verifies developer claims against their actual GitHub code.\n"
        f"Repositories: {', '.join(repo_names)}\n"
        f"Investigate each claim, gather evidence, then call submit_verdict. Be specific. Cap tool use to {MAX_TOOL_CALLS} calls per claim."
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
                max_tokens=4096,
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
                    claim_result = {
                        "claim": claim,
                        "verdict": inp["verdict"],
                        "confidence": inp["confidence"],
                        "summary": inp["summary"],
                        "evidence": inp["evidence"],
                        "receipts": inp.get("receipts", []),
                        "whatToAskNext": inp["whatToAskNext"],
                    }
                    break

                tool_calls_used += 1
                if tool_calls_used > MAX_TOOL_CALLS:
                    result_text = "Tool limit reached. Submit verdict now."
                else:
                    result_text = _run_tool(name, inp, index_ids, github_username, all_repos)

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
    overall = json.loads(synth_resp.choices[0].message.content.strip())

    return {
        "candidate": github_username,
        "githubUrl": f"https://github.com/{github_username}",
        "analyzedRepos": repo_names,
        "overallLarpScore": overall["overallLarpScore"],
        "overallVerdict": overall["overallVerdict"],
        "subscores": overall["subscores"],
        "claims": verified_claims,
        "redemption": overall["redemption"],
        "analyzedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    }


def _run_tool(name: str, inp: dict, index_ids: dict, username: str, repos: list) -> str:
    try:
        repo_name = inp.get("repo", "")
        full_name = next((r["full_name"] for r in repos if r["name"] == repo_name), f"{username}/{repo_name}")
        html_url = f"https://github.com/{full_name}"

        if name == "nia_search":
            index_id = index_ids.get(repo_name)
            if not index_id:
                return f"No Nia index for {repo_name}"
            snippets = _nia_query(index_id, inp.get("query", ""))
            return "\n\n---\n\n".join(f"{s['filePath']}\n{s['content']}" for s in snippets) or "(no results)"

        elif name == "github_commits":
            r = requests.get(
                f"{GITHUB_API}/repos/{full_name}/commits",
                headers=_gh_headers(),
                params={"per_page": 20},
            )
            commits = r.json() if r.ok else []
            return "\n".join(
                f"{c['sha'][:7]} {c['commit']['committer']['date'][:10]} {c['commit']['message'].splitlines()[0][:100]}"
                for c in commits
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
            return "\n".join(paths[:200])

        elif name == "github_file":
            r = requests.get(
                f"{GITHUB_API}/repos/{full_name}/contents/{inp.get('path', '')}",
                headers=_gh_headers(),
            )
            if not r.ok:
                return "File not found"
            data = r.json()
            if data.get("encoding") == "base64":
                return base64.b64decode(data["content"]).decode("utf-8", errors="replace")[:4000]
            return data.get("content", "")

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
def send_verdict_email(to_email: str, candidate_username: str, verdict: dict) -> None:
    from gmail_client import send_verdict_email as _send

    top_receipts = []
    for cv in verdict.get("claims", []):
        for r in cv.get("receipts", [])[:1]:
            top_receipts.append(f'<li><a href="{r["url"]}">{r["label"]}</a> — {r["detail"]}</li>')
        if len(top_receipts) >= 3:
            break

    questions = "\n".join(
        f"<li>{cv['whatToAskNext']}</li>"
        for cv in verdict.get("claims", [])
        if cv.get("whatToAskNext")
    )

    score = verdict.get("overallLarpScore", "?")
    verdict_text = verdict.get("overallVerdict", "")
    score_color = "#22c55e" if score < 30 else "#eab308" if score < 60 else "#ef4444"

    html = f"""
    <div style="font-family:monospace;max-width:640px;margin:0 auto;background:#09090b;color:#e4e4e7;padding:32px;border-radius:8px;">
      <h2 style="color:#fff;margin:0 0 4px">LARPbot Report: <a href="https://github.com/{candidate_username}" style="color:#a1a1aa">{candidate_username}</a></h2>
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

      <h3 style="color:#a1a1aa;font-size:12px;text-transform:uppercase;letter-spacing:.1em;margin:24px 0 8px">What to Ask Next</h3>
      <ul style="color:#a1a1aa;font-size:13px;line-height:1.8">{questions}</ul>

      <p style="color:#3f3f46;font-size:11px;margin-top:32px">
        Generated by LARPbot · <a href="https://github.com/{candidate_username}" style="color:#3f3f46">github.com/{candidate_username}</a>
      </p>
    </div>
    """

    _send(
        to_email=to_email,
        subject=f"LARPbot: {candidate_username} — LARP Score {score}/100",
        html_body=html,
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
def send_error_email(to_email: str, candidate_username: str, reason: str) -> None:
    from gmail_client import send_verdict_email as _send

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

    _send(
        to_email=to_email,
        subject=f"LARPbot: Could not analyze {candidate_username}",
        html_body=html,
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
    import memory
    from gmail_client import download_attachment, extract_github_username, mark_as_read

    emails = fetch_unread_emails()
    processed = []
    skipped_cached = []

    for email in emails:
        from_email = email["from_email"]
        body = email["body_text"]

        username = extract_github_username(body)
        if not username:
            mark_as_read(email["message_id"])
            continue

        # Check durable memory — skip if already analyzed
        cached = memory.get_candidate(username)
        if cached:
            skipped_cached.append(username)
            mark_as_read(email["message_id"])
            # Re-send cached verdict so recruiter still gets a response
            send_verdict_email(from_email, username, cached)
            continue

        try:
            # Parse PDF resume if attached
            resume_text = ""
            for attachment in email["attachments"]:
                if "pdf" in attachment["mime_type"].lower() or attachment["filename"].endswith(".pdf"):
                    pdf_bytes = download_attachment(email["message_id"], attachment["attachment_id"])
                    pdf_b64 = base64.b64encode(pdf_bytes).decode()
                    resume_text = parse_resume_pdf(pdf_b64)
                    break

            # Extract structured claims
            extraction = extract_claims_from_email(body, resume_text)
            github_username = extraction.get("github_username") or username
            claims = extraction.get("claims") or []

            if not claims:
                mark_as_read(email["message_id"])
                continue

            # Index repos and verify claims
            index_ids = index_github_repos(github_username)
            verdict = verify_claims(github_username, claims, index_ids)

            # Store in durable memory
            memory.store_candidate(github_username, verdict)

            # Send verdict to recruiter
            send_verdict_email(from_email, github_username, verdict)
            processed.append(github_username)

        except Exception as e:
            send_error_email(
                from_email,
                username,
                f"An unexpected error occurred during analysis: {e}",
            )

        finally:
            mark_as_read(email["message_id"])

    return {
        "emails_checked": len(emails),
        "candidates_analyzed": processed,
        "candidates_from_cache": skipped_cached,
        "total_in_memory": memory.candidate_count(),
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
    import memory
    return memory.list_candidates()


@application(tags={"project": "larpbot"})
@function(
    description="Return stored verdict for a specific GitHub username",
    image=AGENT_IMAGE,
    timeout=30,
)
def get_candidate(github_username: str) -> Optional[dict]:
    import memory
    return memory.get_candidate(github_username)
