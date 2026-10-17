#!/usr/bin/env bash
set -euo pipefail
expected='uv 0.11.14'
actual="$(uv --version)"
if [[ "$actual" != "$expected"* ]]; then
  echo "Expected $expected to regenerate Python locks, got: $actual" >&2
  exit 1
fi
uv pip compile python/requirements.in --default-index https://pypi.org/simple --python-version 3.13 --python-platform x86_64-pc-windows-msvc --generate-hashes --only-binary=:all: --output-file python/requirements-windows-x64.lock
uv pip compile python/requirements.in --default-index https://pypi.org/simple --python-version 3.13 --python-platform x86_64-manylinux_2_17 --generate-hashes --only-binary=:all: --output-file python/requirements-linux-x64.lock
