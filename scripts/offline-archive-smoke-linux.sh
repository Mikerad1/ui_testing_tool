#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 7 ]]; then
  echo "usage: offline-archive-smoke-linux.sh <node> <probe.mjs> <smoke.mjs> <bundle> <sidecar-exe> <missing-model-exe> <unrelated-cwd>" >&2
  exit 2
fi
NODE_BIN="$(realpath "$1")"
PROBE="$(realpath "$2")"
SMOKE="$(realpath "$3")"
BUNDLE="$(realpath "$4")"
SIDECAR="$(realpath "$5")"
MISSING="$(realpath "$6")"
UNRELATED="$(realpath "$7")"
HOSTILE_BIN="$(mktemp -d)"
trap 'rm -rf "$HOSTILE_BIN"' EXIT
for name in python python3; do printf '#!/bin/sh\necho hostile Python PATH invoked >&2\nexit 97\n' > "$HOSTILE_BIN/$name"; chmod +x "$HOSTILE_BIN/$name"; done

# A fresh network namespace is the isolation boundary; no proxy/environment claims substitute.
sudo -n unshare --net --mount-proc bash -c '
  set -euo pipefail
  NODE_BIN="$1" PROBE="$2" SMOKE="$3" BUNDLE="$4" SIDECAR="$5" MISSING="$6" UNRELATED="$7" HOSTILE_BIN="$8"
  ip link set lo up
  if ip route show default | grep -q .; then echo "network namespace unexpectedly has a default route" >&2; exit 1; fi
  cd "$UNRELATED"
  env -i HOME="$HOME" PATH="$HOSTILE_BIN:/usr/bin:/bin" PYTHONPATH=/hostile/imports PYTHONHOME=/hostile/runtime PYTHONUSERBASE=/hostile/userbase "$NODE_BIN" "$PROBE"
  env -i HOME="$HOME" PATH="$HOSTILE_BIN:/usr/bin:/bin" PYTHONPATH=/hostile/imports PYTHONHOME=/hostile/runtime PYTHONUSERBASE=/hostile/userbase UMB_TEST_BUNDLE_ROOT="$BUNDLE" UMB_TEST_SIDECAR_EXECUTABLE="$SIDECAR" UMB_TEST_MISSING_MODEL_EXECUTABLE="$MISSING" "$NODE_BIN" "$SMOKE"
  env -i HOME="$HOME" PATH="$HOSTILE_BIN:/usr/bin:/bin" PYTHONPATH=/hostile/imports PYTHONHOME=/hostile/runtime PYTHONUSERBASE=/hostile/userbase "$BUNDLE/umb" --help
' _ "$NODE_BIN" "$PROBE" "$SMOKE" "$BUNDLE" "$SIDECAR" "$MISSING" "$UNRELATED" "$HOSTILE_BIN"
