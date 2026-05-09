"""
One-time script to get a Gmail OAuth refresh token.

1. Go to console.cloud.google.com → APIs & Services → Credentials
2. Create OAuth 2.0 Client ID (Desktop application)
3. Download the JSON, set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in your shell
4. Run: python agent/gmail_oauth_setup.py
5. Copy the refresh_token from output → tl secrets set GMAIL_REFRESH_TOKEN <value>
"""

import os
from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]

client_config = {
    "installed": {
        "client_id": os.environ["GMAIL_CLIENT_ID"],
        "client_secret": os.environ["GMAIL_CLIENT_SECRET"],
        "redirect_uris": ["urn:ietf:wg:oauth:2.0:oob", "http://localhost"],
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
    }
}

flow = InstalledAppFlow.from_client_config(client_config, SCOPES)
creds = flow.run_local_server(port=0)

print("\n=== Copy this to Tensorlake secrets ===")
print(f"tl secrets set GMAIL_REFRESH_TOKEN {creds.refresh_token}")
print(f"tl secrets set GMAIL_CLIENT_ID {creds.client_id}")
print(f"tl secrets set GMAIL_CLIENT_SECRET {creds.client_secret}")
