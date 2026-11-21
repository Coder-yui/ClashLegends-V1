"""Prepare one administrator and invite-only beta accounts for a lobby."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--directory", type=Path, default=Path(".local/accounts"))
parser.add_argument("--beta", type=int, choices=range(0, 101), default=3)
args = parser.parse_args()
os.umask(0o077)
args.directory.mkdir(parents=True, exist_ok=False)
registry = {}
credentials = []
for name in ["admin", *(f"beta-{i:02}" for i in range(1, args.beta + 1))]:
    key = secrets.token_urlsafe(32)
    registry[name] = {
        "role": "admin" if name == "admin" else "beta",
        "digest": hashlib.sha256(key.encode()).hexdigest(),
    }
    credentials.append(f"{name}\t{key}")
(args.directory / "login-keys.txt").write_text("\n".join(credentials) + "\n")
(args.directory / "registry.json").write_text(json.dumps(registry, indent=2) + "\n")
