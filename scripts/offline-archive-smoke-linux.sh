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
  export LC_ALL=C
  ip link set lo up
  links="$(ip -o link show)"
  while IFS= read -r link; do
    [[ -z "$link" ]] && continue
    if [[ ! "$link" =~ ^[0-9]+:[[:space:]]lo: ]]; then
      echo "network namespace has a non-loopback interface: $link" >&2
      exit 1
    fi
  done <<< "$links"

  is_allowed_loopback_route() {
    local family="$1" route="$2" remainder="$2" destination
    case "$remainder" in
      local\ *) remainder="${remainder#local }" ;;
      broadcast\ *) remainder="${remainder#broadcast }" ;;
    esac
    destination="${remainder%% *}"
    [[ " $route " == *" dev lo "* ]] || return 1
    case "$family:$destination" in
      -4:127.*|-6:::1|-6:::1/128) return 0 ;;
      *) return 1 ;;
    esac
  }

  # Exercise the same exact-destination classifier used for production routes.
  for route in "local ::1 dev lo table local" "local ::1/128 dev lo table local"; do
    if ! is_allowed_loopback_route -6 "$route"; then
      echo "loopback route classifier rejected valid route: $route" >&2
      exit 1
    fi
  done
  for route in "local ::10 dev lo table local" "::10 dev lo table 100"; do
    if is_allowed_loopback_route -6 "$route"; then
      echo "loopback route classifier accepted non-loopback destination: $route" >&2
      exit 1
    fi
  done

  for family in -4 -6; do
    # `table all default` is an iproute2 route selector; it searches every table,
    # unlike `route show default`, which only inspects the main table by default.
    defaults="$(ip "$family" route show table all default)"
    if [[ -n "$defaults" ]]; then
      echo "network namespace unexpectedly has $family default route(s): $defaults" >&2
      exit 1
    fi

    # The local table legitimately contains loopback host/broadcast routes. Allow
    # only loopback destinations that are explicitly attached to lo; reject every
    # other route from every table.
    routes="$(ip "$family" route show table all)"
    while IFS= read -r route; do
      [[ -z "$route" ]] && continue
      if ! is_allowed_loopback_route "$family" "$route"; then
        echo "network namespace has a non-loopback $family route: $route" >&2
        exit 1
      fi
    done <<< "$routes"
  done

  assert_unreachable_route_lookup() {
    family="$1" destination="$2"
    if output="$(ip "$family" route get "$destination" 2>&1)"; then
      echo "network namespace unexpectedly routes $family destination $destination: $output" >&2
      return 1
    fi
    if [[ "$output" != *"Network is unreachable"* ]]; then
      echo "route lookup to $destination failed for an unexpected reason: $output" >&2
      return 1
    fi
    echo "Confirmed no route to $destination ($family): Network is unreachable."
  }
  assert_unreachable_route_lookup -4 1.1.1.1
  assert_unreachable_route_lookup -6 2606:4700:4700::1111

  cd "$UNRELATED"
  env -i HOME="$HOME" PATH="$HOSTILE_BIN:/usr/bin:/bin" PYTHONPATH=/hostile/imports PYTHONHOME=/hostile/runtime PYTHONUSERBASE=/hostile/userbase UMB_OFFLINE_NETNS_ACTIVE=1 "$NODE_BIN" "$PROBE" --expect-netns-blocked
  env -i HOME="$HOME" PATH="$HOSTILE_BIN:/usr/bin:/bin" PYTHONPATH=/hostile/imports PYTHONHOME=/hostile/runtime PYTHONUSERBASE=/hostile/userbase UMB_TEST_BUNDLE_ROOT="$BUNDLE" UMB_TEST_SIDECAR_EXECUTABLE="$SIDECAR" UMB_TEST_MISSING_MODEL_EXECUTABLE="$MISSING" "$NODE_BIN" "$SMOKE"
  env -i HOME="$HOME" PATH="$HOSTILE_BIN:/usr/bin:/bin" PYTHONPATH=/hostile/imports PYTHONHOME=/hostile/runtime PYTHONUSERBASE=/hostile/userbase "$BUNDLE/umb" --help
' _ "$NODE_BIN" "$PROBE" "$SMOKE" "$BUNDLE" "$SIDECAR" "$MISSING" "$UNRELATED" "$HOSTILE_BIN"
