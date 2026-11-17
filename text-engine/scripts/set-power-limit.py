#!/usr/bin/env python3
"""Set and verify the configured B70 card power limit."""

import os
from pathlib import Path
from b70_device import b70_device


DEVICE = b70_device()
limit_w = int(os.environ.get("B70_POWER_LIMIT_W", "180"))
matches = sorted(DEVICE.glob("hwmon/hwmon*/power1_cap"))
if len(matches) != 1:
    raise SystemExit(f"expected exactly one B70 power1_cap below {DEVICE}, got {matches}")
path = matches[0]
wanted = limit_w * 1_000_000
if int(path.read_text().strip()) != wanted:
    path.write_text(f"{wanted}\n")
actual = int(path.read_text().strip())
if actual != wanted:
    raise SystemExit(f"power cap verification failed: wanted {wanted}, got {actual}")
print(f"B70 card power limit verified: {limit_w} W ({path})")
