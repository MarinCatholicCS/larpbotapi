"""
Register the 5-minute cron schedule on the poll_recruiting_inbox application.

Run after `tl deploy agent/larpbot_agent.py`:
  python agent/setup_cron.py

To list schedules:
  python agent/setup_cron.py --list

To delete all schedules:
  python agent/setup_cron.py --delete-all
"""

import argparse
import json
import os
import sys

import requests

BASE = "https://api.tensorlake.ai"
APP = "poll_recruiting_inbox"


def headers():
    key = os.environ.get("TENSORLAKE_API_KEY")
    if not key:
        sys.exit("TENSORLAKE_API_KEY not set")
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def create_schedule():
    resp = requests.post(
        f"{BASE}/applications/{APP}/cron-schedules",
        headers=headers(),
        json={"cron_expression": "*/5 * * * *"},
    )
    if resp.ok:
        data = resp.json()
        print(f"Schedule created: {data.get('schedule_id')}")
        print("Expression: */5 * * * * (every 5 minutes)")
    else:
        print(f"Failed: {resp.status_code} {resp.text}")


def list_schedules():
    resp = requests.get(
        f"{BASE}/applications/{APP}/cron-schedules",
        headers=headers(),
    )
    if resp.ok:
        schedules = resp.json()
        if not schedules:
            print("No schedules found.")
        for s in schedules:
            print(json.dumps(s, indent=2))
    else:
        print(f"Failed: {resp.status_code} {resp.text}")


def delete_all():
    resp = requests.get(f"{BASE}/applications/{APP}/cron-schedules", headers=headers())
    if not resp.ok:
        print(f"Failed to list: {resp.status_code}")
        return
    for s in resp.json():
        sid = s.get("id") or s.get("schedule_id")
        dr = requests.delete(f"{BASE}/applications/{APP}/cron-schedules/{sid}", headers=headers())
        print(f"Deleted {sid}: {dr.status_code}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--delete-all", action="store_true")
    args = parser.parse_args()

    if args.list:
        list_schedules()
    elif args.delete_all:
        delete_all()
    else:
        create_schedule()
