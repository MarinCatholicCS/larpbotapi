"""
Gmail API wrapper using stored OAuth refresh token.

Required secrets (set via `tl secrets set KEY value`):
  GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN

To get a refresh token the first time, run:
  python agent/gmail_oauth_setup.py
"""

import base64
import os
import re
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Optional

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]
RECRUITING_LABEL = "INBOX"  # filter to unread INBOX; narrow with a label if you have one


def _service():
    creds = Credentials(
        token=None,
        refresh_token=os.environ["GMAIL_REFRESH_TOKEN"],
        client_id=os.environ["GMAIL_CLIENT_ID"],
        client_secret=os.environ["GMAIL_CLIENT_SECRET"],
        token_uri="https://oauth2.googleapis.com/token",
        scopes=SCOPES,
    )
    creds.refresh(Request())
    return build("gmail", "v1", credentials=creds)


def get_unread_recruiting_emails() -> list[dict]:
    """
    Returns list of dicts with keys:
      message_id, thread_id, from_email, subject, body_text, attachments
    where attachments = [{"filename": str, "attachment_id": str, "mime_type": str}]
    """
    svc = _service()
    query = "is:unread category:primary"
    resp = svc.users().messages().list(userId="me", q=query, maxResults=20).execute()
    messages = resp.get("messages", [])

    results = []
    for m in messages:
        msg = svc.users().messages().get(userId="me", id=m["id"], format="full").execute()
        results.append(_parse_message(msg))
    return results


def _parse_message(msg: dict) -> dict:
    headers = {h["name"]: h["value"] for h in msg["payload"].get("headers", [])}
    body_text = _extract_body(msg["payload"])
    attachments = _extract_attachments(msg["payload"])
    return {
        "message_id": msg["id"],
        "thread_id": msg["threadId"],
        "from_email": headers.get("From", ""),
        "subject": headers.get("Subject", ""),
        "body_text": body_text,
        "attachments": attachments,
    }


def _extract_body(payload: dict) -> str:
    if payload.get("body", {}).get("data"):
        return base64.urlsafe_b64decode(payload["body"]["data"]).decode("utf-8", errors="replace")
    for part in payload.get("parts", []):
        if part.get("mimeType") == "text/plain" and part.get("body", {}).get("data"):
            return base64.urlsafe_b64decode(part["body"]["data"]).decode("utf-8", errors="replace")
    # fallback: try html part
    for part in payload.get("parts", []):
        if part.get("mimeType") == "text/html" and part.get("body", {}).get("data"):
            raw = base64.urlsafe_b64decode(part["body"]["data"]).decode("utf-8", errors="replace")
            return re.sub(r"<[^>]+>", " ", raw)  # strip html tags
    return ""


def _extract_attachments(payload: dict) -> list[dict]:
    attachments = []
    for part in payload.get("parts", []):
        if part.get("filename") and part.get("body", {}).get("attachmentId"):
            attachments.append({
                "filename": part["filename"],
                "attachment_id": part["body"]["attachmentId"],
                "mime_type": part.get("mimeType", ""),
            })
    return attachments


def download_attachment(message_id: str, attachment_id: str) -> bytes:
    svc = _service()
    resp = svc.users().messages().attachments().get(
        userId="me", messageId=message_id, id=attachment_id
    ).execute()
    return base64.urlsafe_b64decode(resp["data"])


def mark_as_read(message_id: str) -> None:
    svc = _service()
    svc.users().messages().modify(
        userId="me",
        id=message_id,
        body={"removeLabelIds": ["UNREAD"]},
    ).execute()


def send_verdict_email(to_email: str, subject: str, html_body: str) -> None:
    svc = _service()
    msg = MIMEMultipart("alternative")
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.attach(MIMEText(html_body, "html"))
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    svc.users().messages().send(userId="me", body={"raw": raw}).execute()


def extract_github_username(text: str) -> Optional[str]:
    """Pull the first github.com/<username> from email body."""
    match = re.search(r"github\.com/([A-Za-z0-9_-]+)", text)
    return match.group(1) if match else None
