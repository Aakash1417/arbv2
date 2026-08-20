#!/usr/bin/env python3
"""
LoL Arbitrage Scanner - Python Scheduler

Runs the arbitrage scanner, dispatches results to Telegram, and dynamically schedules
the next scan:
  - Every 15 minutes if matches are currently live (started within the last 2 hours).
  - Every 2 hours otherwise.

Usage:
  python3 scheduler.py             # Start dynamic scheduler
  python3 scheduler.py --dry-run   # Preview formatting without sending Telegram alerts
  python3 scheduler.py --once      # Run once and exit immediately
"""

import sys
import os
import json
import time
import subprocess
from datetime import datetime, timezone, timedelta
from pathlib import Path

# Paths
BASE_DIR = Path(__file__).resolve().parent
SCAN_JSON_PATH = BASE_DIR / "scan.json"

# Default intervals in minutes
DEFAULT_IDLE_INTERVAL_MINUTES = 120
DEFAULT_LIVE_INTERVAL_MINUTES = 15
DEFAULT_LIVE_LOOKBACK_HOURS = 2


def get_local_now_str():
    """Returns a readable timestamp."""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def run_scanner(dry_run=False):
    """Executes notify-telegram.js to scan markets and dispatch Telegram alert."""
    cmd = [
        "node",
        str(BASE_DIR / "notify-telegram.js"),
        "--json",
        str(SCAN_JSON_PATH),
    ]
    if dry_run:
        cmd.append("--dry-run")

    print(f"\n[{get_local_now_str()}] 🚀 Running arbitrage scan...")
    sys.stdout.flush()

    res = subprocess.run(cmd, cwd=str(BASE_DIR))
    return res.returncode == 0


def analyze_active_matches(lookback_hours=DEFAULT_LIVE_LOOKBACK_HOURS):
    """
    Inspects the scan fixtures to check if any matches started within the last N hours
    or are currently underway.
    """
    if not SCAN_JSON_PATH.exists():
        return [], 0

    try:
        with open(SCAN_JSON_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as err:
        print(f"[warn] Could not read {SCAN_JSON_PATH}: {err}")
        return [], 0

    fixtures = data.get("fixtures", [])
    now_ms = time.time() * 1000
    lookback_ms = lookback_hours * 3600 * 1000

    live_matches = []
    for fix in fixtures:
        start_ms = fix.get("startTime")
        if not start_ms:
            continue

        # Match started within the last 2 hours (or starts in <= 10 mins)
        if (now_ms - lookback_ms) <= start_ms <= (now_ms + 10 * 60 * 1000):
            elapsed_mins = int((now_ms - start_ms) / 60000)
            status = f"started {elapsed_mins}m ago" if elapsed_mins >= 0 else f"starts in {-elapsed_mins}m"
            live_matches.append({
                "league": fix.get("league", "LoL"),
                "name": fix.get("name", "Unknown Match"),
                "status": status,
                "startTime": start_ms,
            })

    total_arbs = len(data.get("arbs", []))
    return live_matches, total_arbs


def main():
    dry_run = "--dry-run" in sys.argv
    run_once_flag = "--once" in sys.argv
    
    # Custom interval options
    live_interval = DEFAULT_LIVE_INTERVAL_MINUTES
    idle_interval = DEFAULT_IDLE_INTERVAL_MINUTES
    lookback_hours = DEFAULT_LIVE_LOOKBACK_HOURS

    for i, arg in enumerate(sys.argv):
        if arg == "--live-interval" and i + 1 < len(sys.argv):
            live_interval = int(sys.argv[i + 1])
        elif arg == "--idle-interval" and i + 1 < len(sys.argv):
            idle_interval = int(sys.argv[i + 1])
        elif arg == "--lookback" and i + 1 < len(sys.argv):
            lookback_hours = float(sys.argv[i + 1])

    print("=" * 60)
    print("       ⚡ LoL Arbitrage Dynamic Python Scheduler ⚡")
    print("=" * 60)
    print(f"  • Idle scan interval:   {idle_interval} minutes")
    print(f"  • Active scan interval: {live_interval} minutes (matches started < {lookback_hours}h ago)")
    print(f"  • Dry run mode:         {'ENABLED' if dry_run else 'DISABLED'}")
    print("=" * 60)

    while True:
        try:
            # 1. Run the scanner and send Telegram alert
            success = run_scanner(dry_run=dry_run)

            # 2. Check for active matches
            live_matches, total_arbs = analyze_active_matches(lookback_hours=lookback_hours)

            if live_matches:
                print(f"\n⚡ {len(live_matches)} active match(es) detected (started < {lookback_hours}h ago):")
                for m in live_matches:
                    print(f"   • [{m['league']}] {m['name']} ({m['status']})")
                sleep_mins = live_interval
            else:
                print("\n💤 No active matches in progress right now.")
                sleep_mins = idle_interval

            if run_once_flag:
                print(f"\n[{get_local_now_str()}] --once flag specified. Exiting.")
                break

            # 3. Schedule next run
            next_run_time = datetime.now() + timedelta(minutes=sleep_mins)
            print(f"\n⏳ Next scan in {sleep_mins} minutes (at {next_run_time.strftime('%H:%M:%S')}).")
            print("   Press Ctrl+C at any time to stop.")
            sys.stdout.flush()

            # Sleep
            time.sleep(sleep_mins * 60)

        except KeyboardInterrupt:
            print("\n\n[🛑] Scheduler stopped by user. Goodbye!")
            break
        except Exception as e:
            print(f"\n[ERROR] Unexpected error: {e}")
            print("Retrying in 60 seconds...")
            time.sleep(60)


if __name__ == "__main__":
    main()
