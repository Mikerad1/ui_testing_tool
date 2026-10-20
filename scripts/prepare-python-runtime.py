#!/usr/bin/env python3
"""Download, hash-verify, and extract the pinned target CPython runtime archive."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import stat
import subprocess
import tempfile
import urllib.request
import zipfile
from pathlib import Path


def windows_installer_filename(version: str) -> str:
    return f"python-{version}-amd64.exe"


def extract_windows_installer(archive_path: Path, staging_dir: Path, version: str) -> Path:
    """Extract only the one expected full installer from the pinned actions archive."""
    installer_name = windows_installer_filename(version)
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        expected = {installer_name, "setup.ps1"}
        if len(names) != len(expected) or set(names) != expected:
            raise ValueError(f"Unexpected Python runtime ZIP entries; expected exactly {sorted(expected)}, got {names}")
        installer_info = next(entry for entry in entries if entry.filename == installer_name)
        if installer_info.is_dir() or stat.S_ISLNK(installer_info.external_attr >> 16):
            raise ValueError("Expected Windows Python installer entry is not a regular file")
        if installer_info.file_size <= 0:
            raise ValueError("Expected Windows Python installer entry is empty")
        staging_dir.mkdir(parents=True, exist_ok=True)
        installer_path = staging_dir / installer_name
        with archive.open(installer_info, "r") as source, installer_path.open("xb") as destination:
            shutil.copyfileobj(source, destination)
    return installer_path


def windows_installer_command(installer: Path, target_dir: Path) -> list[str]:
    return [
        str(installer),
        "/quiet",
        f"TargetDir={target_dir}",
        "InstallAllUsers=0",
        "Include_pip=1",
        "Include_launcher=0",
        "PrependPath=0",
        "AppendPath=0",
    ]


def sanitized_python_environment(source: dict[str, str] | None = None) -> dict[str, str]:
    environment = dict(os.environ if source is None else source)
    for key in list(environment):
        if key.upper().startswith("PYTHON") or key.upper() in {"VIRTUAL_ENV", "CONDA_PREFIX", "__PYVENV_LAUNCHER__"}:
            environment.pop(key, None)
    environment["PYTHONNOUSERSITE"] = "1"
    environment["PYTHONUTF8"] = "1"
    return environment


def run_windows_installer(
    installer: Path,
    target_dir: Path,
    *,
    runner=subprocess.run,
    environment: dict[str, str] | None = None,
) -> tuple[list[str], int]:
    command = windows_installer_command(installer, target_dir)
    result = runner(command, check=False, capture_output=True, text=True, env=sanitized_python_environment(environment))
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(f"Python installer exited with status {result.returncode}: {detail}")
    return command, result.returncode


def run_python_check(python: Path, arguments: list[str], *, runner=subprocess.run, environment: dict[str, str] | None = None) -> str:
    result = runner([str(python), *arguments], check=False, capture_output=True, text=True, env=sanitized_python_environment(environment))
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(f"Python runtime check failed ({arguments!r}, status {result.returncode}): {detail}")
    return "\n".join(part.strip() for part in (result.stdout, result.stderr) if part and part.strip()).strip()


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
    installer_evidence = None
    if target["archive"] == "zip" and args.target == "windows-x64":
        installer_name = windows_installer_filename(manifest["version"])
        staging = Path(tempfile.mkdtemp(prefix="python-installer-", dir=args.output))
        install_target = Path(tempfile.mkdtemp(prefix=f"python-{manifest['version']}-", dir=args.output))
        try:
            installer = extract_windows_installer(args.archive, staging, manifest["version"])
            installer_hash = sha256(installer)
            command, installer_exit_status = run_windows_installer(installer, install_target)
            python = install_target / "python.exe"
            if not python.is_file():
                raise SystemExit(f"Python installer completed but expected interpreter is missing: {python}")
            version = run_python_check(python, ["--version"])
            if version != f"Python {manifest['version']}":
                raise SystemExit(f"Installed interpreter version mismatch: {version}")
            pip_version = run_python_check(python, ["-m", "pip", "--version"])
            if not pip_version.startswith("pip "):
                raise SystemExit(f"Bundled pip did not report a version: {pip_version!r}")
            run_python_check(python, ["-m", "venv", "--help"])
            installer_evidence = {
                "installer_name": installer_name,
                "installer_sha256": installer_hash,
                "installer_exit_status": installer_exit_status,
                "install_options": command[1:],
                "target_dir": install_target.relative_to(args.output).as_posix(),
                "bundled_pip_version": pip_version,
            }
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    elif target["archive"] == "zip":
        with zipfile.ZipFile(args.archive) as archive:
            archive.extractall(args.output)
    else:
        import tarfile
        with tarfile.open(args.archive, "r:gz") as archive:
            archive.extractall(args.output, filter="data")
    if args.target == "windows-x64":
        # The installer branch resolves and validates this exact path above. Never search
        # the archive or run setup.ps1, which mutates the hosted toolcache and registry.
        if installer_evidence is None:
            raise SystemExit("Windows runtime archive is not a supported installer ZIP")
        python = args.output / installer_evidence["target_dir"] / "python.exe"
        version = f"Python {manifest['version']}"
    else:
        candidates = sorted(candidate for candidate in args.output.rglob("python3.13") if candidate.is_file())
        candidates += sorted(candidate for candidate in args.output.rglob("python") if candidate.is_file())
        if not candidates:
            raise SystemExit("Pinned archive extracted but no CPython executable was found")
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
    if installer_evidence is not None:
        evidence["windows_installation"] = installer_evidence
    (args.output / "runtime-input.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(evidence))


if __name__ == "__main__":
    main()
