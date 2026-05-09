"""
Register a Gmail push notification subscription.

After you've created the Pub/Sub topic in GCP Console, run:

    GMAIL_WATCH_TOPIC=projects/<your-project-id>/topics/gmail-watch \
      python agent/setup_gmail_watch.py

This subscribes the inbox to push events. Gmail will publish a message
to the topic every time a new email arrives. The watch expires after
7 days — re-run this script to renew (or wire up a cron in production).

Reuses GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN from
the same env that the agent uses.
"""

import os
import sys

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]


def main() -> None:
    topic = os.environ.get("GMAIL_WATCH_TOPIC")
    if not topic:
        sys.exit(
            "GMAIL_WATCH_TOPIC env var required.\n"
            "Format: projects/<project-id>/topics/<topic-name>\n"
            "Example: projects/larpbot-12345/topics/gmail-watch"
        )

    creds = Credentials(
        token=None,
        refresh_token=os.environ["GMAIL_REFRESH_TOKEN"],
        client_id=os.environ["GMAIL_CLIENT_ID"],
        client_secret=os.environ["GMAIL_CLIENT_SECRET"],
        token_uri="https://oauth2.googleapis.com/token",
        scopes=SCOPES,
    )
    creds.refresh(Request())
    svc = build("gmail", "v1", credentials=creds)

    resp = svc.users().watch(
        userId="me",
        body={
            "topicName": topic,
            "labelIds": ["INBOX"],
            "labelFilterAction": "include",
        },
    ).execute()

    print("Watch registered:")
    print(f"  historyId: {resp.get('historyId')}")
    print(f"  expiration: {resp.get('expiration')} (ms since epoch — ~7 days from now)")
    print("\nGmail will now publish to your topic on every new INBOX message.")


if __name__ == "__main__":
    main()
