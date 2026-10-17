#!/usr/bin/env python3
"""Make an isolated onedir copy with its explicitly collected model package removed."""
from __future__ import annotations

import argparse
import json
import os
import shutil
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        shutil.rmtree(args.output)
    shutil.copytree(args.source, args.output, symlinks=True)
    metadata_files = []
    for candidate in args.output.rglob("meta.json"):
        try:
            metadata = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if metadata.get("name") == "en_core_web_sm" and metadata.get("version") == "3.8.0":
            metadata_files.append(candidate)
    if not metadata_files:
        raise SystemExit("Corrupted-copy preparation cannot find en_core_web_sm 3.8.0 metadata")
    # Remove the collected model package, retaining the PyInstaller executable/runtime.
    for model_root in sorted({entry.parent for entry in metadata_files}, key=lambda p: len(p.parts), reverse=True):
        if model_root.exists():
            shutil.rmtree(model_root)
    executable = args.output / ("umb-memory-sidecar.exe" if os.name == "nt" else "umb-memory-sidecar")
    if not executable.is_file():
        raise SystemExit("Corrupted copy unexpectedly lost its sidecar executable")
    if any(path.is_symlink() for path in args.output.rglob("*")):
        raise SystemExit("Corrupted test copy contains symlinks")
    print(f"Prepared missing-model test copy at {args.output}")


if __name__ == "__main__":
    main()
