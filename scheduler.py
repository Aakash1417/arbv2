#!/usr/bin/env python3
"""
LoL Arbitrage Scanner - Fixed 15-Minute Python Scheduler

Runs the arbitrage scanner every 15 minutes. Dispatches newly discovered
opportunities to Telegram (using SQLite database deduplication) and logs scan output.

Usage:
  python3 scheduler.py             # Start 15-minute scheduler loop
  python3 scheduler.py --dry-run   # Preview formatting without sending Telegram alerts
  python3 scheduler.py --once      # Run once and exit immediately
  python3 scheduler.py --interval 15 # Custom interval in minutes (default: 15)
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

DEFAULT_SCAN_INTERVAL_MINUTES = 15


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


def main():
    dry_run = "--dry-run" in sys.argv
    run_once_flag = "--once" in sys.argv

    scan_interval = DEFAULT_SCAN_INTERVAL_MINUTES

    for i, arg in enumerate(sys.argv):
        if arg in ("--interval", "--live-interval", "--idle-interval") and i + 1 < len(sys.argv):
            try:
                scan_interval = int(sys.argv[i + 1])
            except ValueError:
                pass

    print("=" * 60)
    print("       ⚡ LoL Arbitrage 15-Minute Python Scheduler ⚡")
    print("=" * 60)
    print(f"  • Fixed scan interval: {scan_interval} minutes")
    print(f"  • Dry run mode:        {'ENABLED' if dry_run else 'DISABLED'}")
    print("=" * 60)

    while True:
        try:
            # 1. Run the scanner and dispatch new arbs to Telegram
            run_scanner(dry_run=dry_run)

            if run_once_flag:
                print(f"\n[{get_local_now_str()}] --once flag specified. Exiting.")
                break

            # 2. Schedule next run
            next_run_time = datetime.now() + timedelta(minutes=scan_interval)
            print(f"\n⏳ Next scan in {scan_interval} minutes (at {next_run_time.strftime('%H:%M:%S')}).")
            print("   Press Ctrl+C at any time to stop.")
            sys.stdout.flush()

            # Sleep
            time.sleep(scan_interval * 60)

        except KeyboardInterrupt:
            print("\n\n[🛑] Scheduler stopped by user. Goodbye!")
            break
        except Exception as e:
            print(f"\n[ERROR] Unexpected error: {e}")
            print("Retrying in 60 seconds...")
            time.sleep(60)


if __name__ == "__main__":
    main()

