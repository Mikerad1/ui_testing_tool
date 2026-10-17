#!/usr/bin/env python3
"""Download, hash-verify, and extract the pinned target CPython runtime archive."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import urllib.request
import zipfile
from pathlib import Path


def sha256(filename: Path) -> str:
    digest = hashlib.sha256()
    with filename.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("target", choices=("windows-x64", "linux-x64"))
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--archive", required=True, type=Path)
    args = parser.parse_args()
    actual_target = "windows-x64" if os.name == "nt" else "linux-x64" if platform.system() == "Linux" else "unsupported"
    if args.target != actual_target or platform.machine().lower() not in ("amd64", "x86_64"):
        raise SystemExit(f"Python runtime target must match native x64 runner (requested {args.target}, detected {actual_target}/{platform.machine()})")
    repo = Path(__file__).resolve().parents[1]
    manifest = json.loads((repo / "python/runtime-artifacts.json").read_text(encoding="utf-8"))
    target = manifest["targets"][args.target]
    args.archive.parent.mkdir(parents=True, exist_ok=True)
    if not args.archive.exists():
        request = urllib.request.Request(target["url"], headers={"User-Agent": "UMB-Python-runtime-builder"})
        with urllib.request.urlopen(request, timeout=120) as response, args.archive.open("wb") as output:
            shutil.copyfileobj(response, output)
    actual = sha256(args.archive)
    if actual != target["sha256"]:
        raise SystemExit(f"CPython runtime SHA-256 mismatch: expected {target['sha256']}, received {actual}")
    if args.output.exists():
        shutil.rmtree(args.output)
    args.output.mkdir(parents=True, exist_ok=True)
    if target["archive"] == "zip":
        with zipfile.ZipFile(args.archive) as archive:
            archive.extractall(args.output)
    else:
        import tarfile
        with tarfile.open(args.archive, "r:gz") as archive:
            archive.extractall(args.output, filter="data")
    candidates = list(args.output.rglob("python.exe" if os.name == "nt" else "python3.13"))
    if os.name != "nt":
        candidates += list(args.output.rglob("python"))
    candidates = sorted(candidate for candidate in candidates if candidate.is_file())
    if not candidates:
        raise SystemExit("Pinned archive extracted but no CPython executable was found")
    subprocess = __import__("subprocess")
    python = None
    version = None
    for candidate in candidates:
        try:
            candidate_version = subprocess.check_output([str(candidate), "--version"], text=True, stderr=subprocess.STDOUT).strip()
        except (OSError, subprocess.CalledProcessError):
            continue
        if candidate_version == f"Python {manifest['version']}":
            python, version = candidate, candidate_version
            break
    if python is None or version is None:
        raise SystemExit(f"No extracted interpreter reported Python {manifest['version']}")
    evidence = {
        "target": args.target,
        "url": target["url"],
        "archive_sha256": actual,
        "python_executable": python.relative_to(args.output).as_posix(),
        "python_version": version,
    }
    (args.output / "runtime-input.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(evidence))


if __name__ == "__main__":
    main()
