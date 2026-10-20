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
# ZIP/DOS timestamps cannot predate 1980-01-01; use its UTC Unix epoch as the
# deterministic reproducible-build time to keep zip-based build tools valid.
REPRODUCIBLE_SOURCE_DATE_EPOCH = 315532800


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


def model_metadata_paths_relative_to_ondir(metadata_files: list[Path], onedir_root: Path) -> list[str]:
    """Return model metadata locations relative to the frozen onedir, never temp build paths."""
    return sorted(path.relative_to(onedir_root).as_posix() for path in metadata_files)


def venv_setup_commands(base_python: Path, venv_dir: Path, lock_file: Path) -> tuple[list[str], list[str], Path]:
    venv_python = venv_dir / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    create_command = [str(base_python), "-m", "venv", str(venv_dir), "--without-pip"]
    install_command = [
        str(base_python), "-m", "pip", "--python", str(venv_python), "install", "--isolated",
        "--index-url", "https://pypi.org/simple", "--require-hashes", "--only-binary=:all:", "-r", str(lock_file),
    ]
    return create_command, install_command, venv_python


def bootstrap_pip_version(base_python: Path, *, env: dict[str, str]) -> str:
    version_command = [str(base_python), "-m", "pip", "--version"]
    help_command = [str(base_python), "-m", "pip", "--help"]
    print("+", " ".join(version_command), flush=True)
    version_output = subprocess.check_output(version_command, text=True, stderr=subprocess.STDOUT, env=env).strip()
    print("+", " ".join(help_command), flush=True)
    help_output = subprocess.check_output(help_command, text=True, stderr=subprocess.STDOUT, env=env)
    if not version_output.startswith("pip "):
        raise SystemExit(f"Pinned base interpreter did not report bundled pip version: {version_output!r}")
    if "--python <python>" not in help_output:
        raise SystemExit(f"Bundled {version_output} lacks pip --python support required for a no-ensurepip isolated install")
    return version_output


def run_captured(command: list[str], *, label: str, **kwargs: object) -> None:
    print("+", " ".join(command), flush=True)
    result = subprocess.run(command, check=False, capture_output=True, text=True, **kwargs)
    if result.returncode != 0:
        detail = "\n".join(part.strip() for part in (result.stdout, result.stderr) if part and part.strip())
        raise RuntimeError(f"{label} failed with exit status {result.returncode}.\nCommand: {command!r}\n{detail}")


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
    env.update({"SOURCE_DATE_EPOCH": str(REPRODUCIBLE_SOURCE_DATE_EPOCH), "PYTHONHASHSEED": "0", "PYTHONUTF8": "1", "TZ": "UTC", "PIP_DISABLE_PIP_VERSION_CHECK": "1"})
    env["PIP_INDEX_URL"] = "https://pypi.org/simple"
    env.pop("PIP_EXTRA_INDEX_URL", None)
    with tempfile.TemporaryDirectory(prefix="umb-sidecar-build-") as temporary:
        temp = Path(temporary)
        venv = temp / "venv"
        base_pip_version = bootstrap_pip_version(args.python, env=env)
        create_venv_command, install_lock_command, python = venv_setup_commands(args.python, venv, lock)
        run_captured(create_venv_command, label="Creating isolated venv without ensurepip", cwd=repo, env=env)
        if not python.is_file():
            raise SystemExit(f"Pip-free venv creation succeeded but its interpreter is missing: {python}")
        run_captured(install_lock_command, label=f"Installing hash-locked requirements into venv via {base_pip_version}", cwd=repo, env=env)
        check_code = (
            "import importlib.metadata as m, json, spacy, en_core_web_sm; "
            "n=en_core_web_sm.load(); print(json.dumps({'python':__import__('platform').python_version(),"
            "'platform':__import__('platform').platform(),'machine':__import__('platform').machine(),"
            "'libc':__import__('platform').libc_ver(),"
            "'spacy':spacy.__version__,'model_package':en_core_web_sm.__name__,"
            "'model_distribution_version':m.version('en-core-web-sm'),"
            "'model_metadata_name':n.meta.get('name'),'model_metadata_version':n.meta.get('version'),"
            "'distributions':{k:m.version(k) for k in ['spacy','en-core-web-sm','pyinstaller','pyinstaller-hooks-contrib']}})); n('UMB build smoke.')"
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
            "bootstrap_pip_version": base_pip_version,
        },
        "verified_versions": metadata,
        "explicit_model_collection": {
            "hidden_import": "en_core_web_sm",
            "model_metadata_paths_relative_to_ondir": model_metadata_paths_relative_to_ondir(model_metadata, built),
        },
        "materialized_in_tree_symlinks": materialized_symlinks,
        "frozen_files_sha256": inventory,
        "build_environment": {key: env[key] for key in ("SOURCE_DATE_EPOCH", "PYTHONHASHSEED", "PYTHONUTF8", "TZ")},
    }
    (args.output / "build-inputs.json").write_text(json.dumps(provenance, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({key: provenance[key] for key in ("target", "requirements_lock", "requirements_lock_sha256", "verified_versions", "explicit_model_collection")}, indent=2))


if __name__ == "__main__":
    main()
