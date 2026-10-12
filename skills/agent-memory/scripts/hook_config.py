#!/usr/bin/env python3
"""Print POSIX hook configuration for an installed project; never write it."""
import argparse
import json
import os
from pathlib import Path
import shlex
import sys


def config(project, client, python=sys.executable):
    if os.name != "posix":
        raise ValueError("Hook command generation currently supports POSIX shells only")
    if client not in {"codex", "qoder"}:
        raise ValueError("Unknown client")
    root = Path(project).resolve()
    required = [root / "memory.json"] + [root / "scripts" / name for name in
                ("check_memory.py", "load_memory.py", "maintain_memory.py")]
    if not all(path.is_file() for path in required):
        raise ValueError("Copy/merge the example project before generating hooks")

    def handler(name, full_context=False):
        value = {"type": "command", "command": shlex.join(
            [str(python), "-B", str(root / "scripts" / name), "--hook"]), "timeout": 5}
        if client == "codex" and full_context:
            value["additionalContextLimit"] = 0
        return value

    return {"hooks": {
        "SessionStart": [
            {"hooks": [handler("check_memory.py")]},
            {"hooks": [handler("load_memory.py", True)]},
        ],
        "PostToolUse": [{"matcher": ".*", "hooks": [handler("check_memory.py", True)]}],
    }}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("--client", choices=("codex", "qoder"), required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(config(args.project, args.client), ensure_ascii=False, indent=2))
    except (OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
