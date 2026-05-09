"""
Candidate verdict store backed by SQLite.

Tensorlake MicroVM sandboxes preserve their filesystem across suspend/resume,
so this file survives between cron invocations as long as the same container
is reused. That is the "durable memory" primitive for this agent.
"""

import json
import sqlite3
from datetime import datetime, timezone
from typing import Optional

DB_PATH = "/tmp/larpbot_memory.db"


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
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


def get_candidate(username: str) -> Optional[dict]:
    with _conn() as conn:
        row = conn.execute(
            "SELECT verdict_json FROM candidates WHERE github_username = ?",
            (username.lower(),),
        ).fetchone()
    return json.loads(row["verdict_json"]) if row else None


def store_candidate(username: str, verdict: dict) -> None:
    with _conn() as conn:
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


def list_candidates() -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT github_username, larp_score, analyzed_at FROM candidates ORDER BY analyzed_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def candidate_count() -> int:
    with _conn() as conn:
        return conn.execute("SELECT COUNT(*) FROM candidates").fetchone()[0]
