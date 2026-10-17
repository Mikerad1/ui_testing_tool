#!/usr/bin/env python3
"""Build a pinned, target-native PyInstaller onedir sidecar and provenance manifest."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import shutil
import subprocess
import tempfile
from pathlib import Path

EXPECTED = {
    "spacy": "3.8.9",
    "en-core-web-sm": "3.8.0",
    "pyinstaller": "6.22.3",
    "pyinstaller-hooks-contrib": "2026.8",
}


def validate_runtime_metadata(metadata: dict[str, object]) -> None:
    expected_distributions = EXPECTED
    errors = []
    if metadata.get("python") != "3.13.16":
        errors.append(f"python={metadata.get('python')!r}, expected 3.13.16")
    if metadata.get("spacy") != EXPECTED["spacy"]:
        errors.append(f"spacy={metadata.get('spacy')!r}, expected {EXPECTED['spacy']}")
    if metadata.get("model_package") != "en_core_web_sm":
        errors.append(f"model package={metadata.get('model_package')!r}, expected en_core_web_sm")
    if metadata.get("model_distribution_version") != EXPECTED["en-core-web-sm"]:
        errors.append(f"model distribution version={metadata.get('model_distribution_version')!r}, expected {EXPECTED['en-core-web-sm']}")
    if metadata.get("model_metadata_version") != EXPECTED["en-core-web-sm"]:
        errors.append(f"loaded pipeline metadata version={metadata.get('model_metadata_version')!r}, expected {EXPECTED['en-core-web-sm']}")
    distributions = metadata.get("distributions")
    if not isinstance(distributions, dict):
        errors.append("distribution versions are missing")
    else:
        for package, expected in expected_distributions.items():
            if distributions.get(package) != expected:
                errors.append(f"distribution {package}={distributions.get(package)!r}, expected {expected}")
    if errors:
        raise SystemExit("Installed runtime/build pin mismatch: " + "; ".join(errors))


def sha256(filename: Path) -> str:
    digest = hashlib.sha256()
    with filename.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(command: list[str], **kwargs: object) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, check=True, **kwargs)


def reject_symlinks(root: Path) -> None:
    for entry in root.rglob("*"):
        if entry.is_symlink():
            raise SystemExit(f"PyInstaller output contains unsupported symlink: {entry}")


def materialize_safe_symlinks(root: Path) -> list[str]:
    root = root.resolve()
    materialized: list[str] = []
    while True:
        links = [entry for entry in root.rglob("*") if entry.is_symlink()]
        if not links:
            return materialized
        for link in links:
            target = link.resolve(strict=True)
            try:
                target.relative_to(root)
            except ValueError as error:
                raise SystemExit(f"Refusing symlink target outside staged onedir: {link} -> {target}") from error
            if target.is_dir():
                if target == link or target in link.parents:
                    raise SystemExit(f"Refusing cyclic/ancestor directory symlink: {link} -> {target}")
                temporary = link.with_name(link.name + ".materialized-tmp")
                if temporary.exists():
                    shutil.rmtree(temporary)
                shutil.copytree(target, temporary, symlinks=True)
                link.unlink()
                temporary.rename(link)
            else:
                temporary = link.with_name(link.name + ".materialized-tmp")
                shutil.copy2(target, temporary)
                link.unlink()
                temporary.rename(link)
            materialized.append(link.relative_to(root).as_posix())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", required=True, type=Path, help="extracted, hash-verified CPython executable")
    parser.add_argument("--target", required=True, choices=("windows-x64", "linux-x64"))
    parser.add_argument("--runtime-input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    actual_target = "windows-x64" if os.name == "nt" else "linux-x64" if platform.system() == "Linux" else "unsupported"
    if args.target != actual_target or platform.machine().lower() not in ("amd64", "x86_64"):
        raise SystemExit(f"Sidecar must be built on its native x64 target (requested {args.target}, detected {actual_target}/{platform.machine()})")
    repo = Path(__file__).resolve().parents[1]
    lock = repo / "python" / f"requirements-{args.target}.lock"
    if not lock.is_file():
        raise SystemExit(f"Missing target lock: {lock}")
    if args.output.exists():
        shutil.rmtree(args.output)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.update({"SOURCE_DATE_EPOCH": "0", "PYTHONHASHSEED": "0", "PYTHONUTF8": "1", "TZ": "UTC", "PIP_DISABLE_PIP_VERSION_CHECK": "1"})
    env["PIP_INDEX_URL"] = "https://pypi.org/simple"
    env.pop("PIP_EXTRA_INDEX_URL", None)
    with tempfile.TemporaryDirectory(prefix="umb-sidecar-build-") as temporary:
        temp = Path(temporary)
        venv = temp / "venv"
        run([str(args.python), "-m", "venv", str(venv)], cwd=repo, env=env)
        python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        run([str(python), "-m", "pip", "--isolated", "install", "--index-url", "https://pypi.org/simple", "--require-hashes", "--only-binary=:all:", "-r", str(lock)], cwd=repo, env=env)
        check_code = (
            "import importlib.metadata as m, json, spacy, en_core_web_sm; "
            "n=en_core_web_sm.load(); print(json.dumps({'python':__import__('platform').python_version(),"
            "'platform':__import__('platform').platform(),'machine':__import__('platform').machine(),"
            "'libc':__import__('platform').libc_ver(),"
            "'spacy':spacy.__version__,'model_package':en_core_web_sm.__name__,"
            "'model_distribution_version':m.version('en-core-web-sm'),"
            "'model_metadata_name':n.meta.get('name'),'model_metadata_version':n.meta.get('version'),"
            "'pip':m.version('pip'),'distributions':{k:m.version(k) for k in ['spacy','en-core-web-sm','pyinstaller','pyinstaller-hooks-contrib']}})); n('UMB build smoke.')"
        )
        metadata = json.loads(subprocess.check_output([str(python), "-c", check_code], cwd=repo, env=env, text=True))
        validate_runtime_metadata(metadata)
        dist = temp / "dist"
        work = temp / "work"
        run([str(python), "-m", "PyInstaller", "--clean", "--noconfirm", "--distpath", str(dist), "--workpath", str(work), str(repo / "python/umb_memory_sidecar.spec")], cwd=repo / "python", env=env)
        built = dist / "umb-memory-sidecar"
        executable = built / ("umb-memory-sidecar.exe" if os.name == "nt" else "umb-memory-sidecar")
        if not executable.is_file():
            raise SystemExit(f"PyInstaller onedir executable missing: {executable}")
        model_metadata = [p for p in built.rglob("meta.json") if "en_core_web_sm" in p.as_posix()]
        if not model_metadata:
            raise SystemExit("Frozen output does not visibly contain en_core_web_sm/meta.json")
        frozen_versions = [json.loads(p.read_text(encoding="utf-8")) for p in model_metadata]
        if not any(m.get("version") == EXPECTED["en-core-web-sm"] for m in frozen_versions):
            raise SystemExit(f"Frozen en_core_web_sm package metadata does not contain model version {EXPECTED['en-core-web-sm']}")
        materialized_symlinks = materialize_safe_symlinks(built)
        reject_symlinks(built)
        shutil.copytree(built, args.output)
    inventory = {}
    for file in sorted(args.output.rglob("*")):
        if file.is_file():
            inventory[file.relative_to(args.output).as_posix()] = sha256(file)
    runtime_input = json.loads(args.runtime_input.read_text(encoding="utf-8"))
    provenance = {
        "target": args.target,
        "python_runtime": runtime_input,
        "requirements_lock": lock.relative_to(repo).as_posix(),
        "requirements_lock_sha256": sha256(lock),
        "lock_generation": json.loads((repo / "python/lock-generation.json").read_text(encoding="utf-8")),
        "builder_environment": {
            "platform": metadata["platform"],
            "machine": metadata["machine"],
            "libc": metadata["libc"],
            "installer_pip_version": metadata["pip"],
        },
        "verified_versions": metadata,
        "explicit_model_collection": {
            "hidden_import": "en_core_web_sm",
            "model_data": [p.relative_to(args.output).as_posix() for p in model_metadata],
        },
        "materialized_in_tree_symlinks": materialized_symlinks,
        "frozen_files_sha256": inventory,
        "build_environment": {key: env[key] for key in ("SOURCE_DATE_EPOCH", "PYTHONHASHSEED", "PYTHONUTF8", "TZ")},
    }
    (args.output / "build-inputs.json").write_text(json.dumps(provenance, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({key: provenance[key] for key in ("target", "requirements_lock", "requirements_lock_sha256", "verified_versions", "explicit_model_collection")}, indent=2))


if __name__ == "__main__":
    main()
