#!/usr/bin/env python3
"""Choose the Observatory text unit at login from the runner's persisted policy."""
import argparse
import json
from datetime import datetime
from pathlib import Path
import subprocess
from zoneinfo import ZoneInfo

UNITS = {
    "inkling2-mini-exl3-b70": "b70-inkling2-vllm.service",
    "Qwen3.8-27B": "b70-qwen38-vllm.service",
}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("state", type=Path)
    args = parser.parse_args()
    try:
        policy = json.loads(args.state.read_text())
    except FileNotFoundError:
        policy = {}
    now = datetime.now(ZoneInfo("Europe/Berlin"))
    if policy.get("mode") != "studio" and (now.hour, now.minute) < (22, 45):
        subprocess.run(["systemctl", "--user", "start", UNITS[policy.get("model", "inkling2-mini-exl3-b70")]], check=True)
