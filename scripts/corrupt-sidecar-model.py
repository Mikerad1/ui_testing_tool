#!/usr/bin/env python3
"""Make an isolated onedir copy with its explicitly collected model package removed."""
from __future__ import annotations

import argparse
import json
import os
import shutil
from pathlib import Path


MODEL_PACKAGE = "en_core_web_sm"
MODEL_VERSION = "3.8.0"


def remove_model_package(onedir: Path) -> None:
    """Remove only the collected import package with the expected version."""
    metadata_files = []
    for candidate in onedir.rglob("meta.json"):
        # The package directory identifies the import package. spaCy metadata's
        # name field is a pipeline name and can differ (e.g. core_web_sm).
        if candidate.parent.name != MODEL_PACKAGE:
            continue
        try:
            metadata = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if metadata.get("version") == MODEL_VERSION:
            metadata_files.append(candidate)
    if not metadata_files:
        raise SystemExit("Corrupted-copy preparation cannot find en_core_web_sm 3.8.0 metadata")

    for model_root in sorted({entry.parent for entry in metadata_files}, key=lambda p: len(p.parts), reverse=True):
        if model_root.exists():
            shutil.rmtree(model_root)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        shutil.rmtree(args.output)
    shutil.copytree(args.source, args.output, symlinks=True)
    if any(path.is_symlink() for path in args.output.rglob("*")):
        raise SystemExit("Corrupted test copy contains symlinks")
    # Remove the collected model package, retaining the PyInstaller executable/runtime.
    remove_model_package(args.output)
    executable = args.output / ("umb-memory-sidecar.exe" if os.name == "nt" else "umb-memory-sidecar")
    if not executable.is_file():
        raise SystemExit("Corrupted copy unexpectedly lost its sidecar executable")
    print(f"Prepared missing-model test copy at {args.output}")


if __name__ == "__main__":
    main()
