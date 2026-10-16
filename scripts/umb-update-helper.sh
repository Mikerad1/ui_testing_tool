#!/bin/sh
set -eu
root=${1:?bundle root required}
mode=${2:-apply}
case "$mode" in apply|--preflight) ;; *) printf 'Unknown helper mode: %s\n' "$mode" >&2; exit 2 ;; esac
request="$root/.umb-update-request.json"
lock="$root/.umb-update-lock"
log="$root/umb-update-error.log"
payload="$root/payload"
previous="$root/payload.previous"
fail() { printf '%s\n' "UMB update failed: $*" | tee -a "$log" >&2; exit 1; }
get_version() {
  dir=$1
  node="$dir/runtime/bin/node"
  [ -x "$node" ] || return 1
  "$node" -e 'try{const fs=require("fs"),path=require("path"),p=require(process.argv[1]),root=path.dirname(process.argv[1]),dep=require(path.join(root,"node_modules/better-sqlite3/package.json"));if(p.name!=="ui-memory-browser"||typeof p.version!=="string"||!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(p.version)||dep.name!=="better-sqlite3"||!fs.statSync(path.join(root,"dist/src/cli/index.js")).isFile())process.exit(2);process.stdout.write(p.version)}catch{process.exit(2)}' "$dir/package.json" 2>/dev/null
}
if [ "${3:-}" != '--lock-held' ]; then
  if ! command -v flock >/dev/null 2>&1; then
    if [ -d "$payload" ] && [ ! -L "$payload" ] && current_version=$(get_version "$payload"); then
      if [ "$mode" = '--preflight' ]; then
        printf '%s\n' 'Warning: Linux update recovery is unavailable because flock is missing; the existing payload is valid, so launching it without applying the pending update.' >&2
        exit 0
      fi
      fail 'Linux update cannot be applied because flock (util-linux) is missing; the existing payload is valid and the pending request was preserved.'
    fi
    fail 'Linux update helper requires flock (util-linux); the current payload is missing or invalid, so normal launch cannot safely continue.'
  fi
  if flock -n -E 75 -F "$lock" "$0" "$root" "$mode" --lock-held; then exit 0; else
    status=$?
    [ "$status" -ne 75 ] || fail 'another UMB update helper holds the kernel update lock; retry after it exits.'
    exit "$status"
  fi
fi
if [ -e "$request" ] || [ -L "$request" ]; then [ -f "$request" ] && [ ! -L "$request" ] || fail 'pending request is not a regular file; preserve it for manual inspection'; fi

has_orphans=0
for entry in "$root"/.umb-update-work-* "$root"/.umb-update-stage-* "$root"/.umb-update-request.tmp-*; do
  if [ -e "$entry" ] || [ -L "$entry" ]; then has_orphans=1; break; fi
done
if [ ! -e "$request" ] && [ -d "$payload" ] && [ "$has_orphans" -eq 0 ]; then exit 0; fi
trap 'exit 130' HUP INT TERM

active_payload_processes() {
  for proc in /proc/[0-9]*; do
    pid=${proc##*/}; [ "$pid" = "$$" ] && continue
    [ -r "$proc/cmdline" ] || continue
    args=$(tr '\000' ' ' < "$proc/cmdline" 2>/dev/null || true)
    case "$args" in *"$payload"*|*"$previous"*) return 0 ;; esac
  done
  return 1
}
cleanup_orphans() {
  keep_stage=$1
  for entry in "$root"/.umb-update-work-* "$root"/.umb-update-stage-* "$root"/.umb-update-request.tmp-*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    [ -n "$keep_stage" ] && [ "$entry" = "$keep_stage" ] && continue
    rm -rf -- "$entry" || fail "could not clean stale update artifact: $entry"
  done
}
active_payload_processes && fail 'best-effort process scan found UMB using payload or payload.previous; close all UMB processes and do not launch another UMB command during update, then retry'
[ ! -L "$payload" ] || fail 'payload is a symlink; refusing recovery'
[ ! -L "$previous" ] || fail 'payload.previous is a symlink; refusing recovery'

if [ ! -e "$payload" ]; then
  [ -d "$previous" ] && [ ! -L "$previous" ] || fail 'payload is missing and no safe payload.previous is available; preserve all update files for manual recovery'
  old_version=$(get_version "$previous") || fail 'payload.previous is not a valid UMB payload; refusing to mutate it'
  if [ -f "$request" ]; then
    recovery_node="$previous/runtime/bin/node"
    recovery_stage=$("$recovery_node" -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(r.format!==1||typeof r.stage!=="string"||typeof r.version!=="string"||!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(r.version))throw Error();process.stdout.write(r.stage)}catch{process.exit(2)}' "$request" 2>/dev/null) || fail 'pending request is malformed; payload.previous preserved'
    recovery_stage_parent=${recovery_stage%/*}; recovery_stage_name=${recovery_stage##*/}
    [ "$recovery_stage_parent" = "$root" ] || fail 'pending stage path is outside the bundle; payload.previous preserved'
    case "$recovery_stage_name" in .umb-update-stage-[A-Za-z0-9_-]*) ;; *) fail 'pending stage path is unsafe; payload.previous preserved' ;; esac
  fi
  mv -- "$previous" "$payload" || fail 'could not restore payload.previous; preserve all update files for manual recovery'
  cleanup_orphans "${recovery_stage:-}"
  if [ -f "$request" ]; then
    printf 'Recovered UMB %s from payload.previous. The pending update was preserved for retry.\n' "$old_version"
  else
    printf 'Recovered UMB %s from payload.previous.\n' "$old_version"
  fi
  exit 0
fi

runtime_for() {
  if [ -x "$payload/runtime/bin/node" ]; then printf '%s\n' "$payload/runtime/bin/node"
  elif [ -x "$previous/runtime/bin/node" ]; then printf '%s\n' "$previous/runtime/bin/node"
  else fail 'neither payload nor payload.previous has a usable bundled Node runtime; preserve both directories for manual recovery'; fi
}

has_request=0
stage=
version=
if [ -f "$request" ]; then
  has_request=1
  node=$(runtime_for)
  stage=$("$node" -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(r.format!==1||typeof r.stage!=="string"||typeof r.version!=="string"||!/^\d+\.\d+\.\d+$/.test(r.version))throw Error();process.stdout.write(r.stage)}catch{process.exit(2)}' "$request" 2>/dev/null) || fail 'pending request is malformed; request preserved'
  version=$("$node" -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(r.format!==1||typeof r.stage!=="string"||typeof r.version!=="string"||!/^\d+\.\d+\.\d+$/.test(r.version))throw Error();process.stdout.write(r.version)}catch{process.exit(2)}' "$request" 2>/dev/null) || fail 'pending request is malformed; request preserved'
  stage_parent=${stage%/*}; stage_name=${stage##*/}
  [ "$stage_parent" = "$root" ] || fail 'pending stage path is outside the bundle'
  case "$stage_name" in .umb-update-stage-[A-Za-z0-9_-]*) ;; *) fail 'pending stage path has an unsafe name' ;; esac
  if [ -e "$stage" ]; then
    [ -d "$stage" ] && [ ! -L "$stage" ] || fail 'staged payload is not a safe directory'
  fi
fi

[ -d "$payload" ] && [ ! -L "$payload" ] || fail 'payload exists but is not a safe directory; refusing mutation'
current_version=$(get_version "$payload") || fail 'payload is not a valid UMB payload; refusing mutation'

if [ "$has_request" -eq 0 ]; then
  cleanup_orphans ''
  exit 0
fi

if [ ! -e "$stage" ]; then
  [ "$current_version" = "$version" ] || fail 'pending stage is missing and current payload does not match the requested version; preserve all update files for manual recovery'
  rm -f -- "$request" || fail 'payload matches requested version but request cleanup failed'
  cleanup_orphans ''
  printf 'Updated UMB to %s (recovered completed update).\n' "$version"
  exit 0
fi
[ "$current_version" != "$version" ] || fail 'requested version is already current but its stage still exists; update state is ambiguous, preserve files for manual recovery'

if [ "$mode" = '--preflight' ]; then cleanup_orphans "$stage"; exit 0; fi
[ -d "$stage" ] && [ ! -L "$stage" ] || fail 'staged payload is not a safe directory'
stage_version=$(get_version "$stage") || fail 'staged payload is not a valid UMB payload'
[ "$stage_version" = "$version" ] || fail 'staged payload version does not match request'

[ ! -e "$previous" ] || [ ! -L "$previous" ] || fail 'payload.previous is not a safe directory'
previous_exists=0
[ ! -e "$previous" ] || previous_exists=1
if [ "$previous_exists" -eq 1 ]; then rm -rf -- "$previous" || fail 'could not prune unused payload.previous'; fi
mv -- "$payload" "$previous" || fail 'could not move current payload to payload.previous'
if ! mv -- "$stage" "$payload"; then
  mv -- "$previous" "$payload" || fail 'swap failed and rollback could not restore payload.previous'
  fail 'could not move staged payload into place; previous payload restored'
fi
target_version=$(get_version "$payload") || target_version=
if [ "$target_version" != "$version" ]; then
  rm -rf -- "$payload"
  if ! mv -- "$previous" "$payload"; then fail 'target verification failed and rollback could not restore payload.previous; request and stage preserved for manual recovery'; fi
  rm -f -- "$request" || fail 'target verification failed; previous payload restored but invalid request cleanup failed'
  rm -rf -- "$stage" || fail 'target verification failed; previous payload restored but invalid stage cleanup failed'
  fail 'target version verification failed; previous payload restored and invalid request/stage discarded; retry the update'
fi
rm -f -- "$request" || fail 'update applied but request cleanup failed; inspect payload and request versions'
cleanup_orphans ''
printf 'Updated UMB to %s. Previous payload retained at payload.previous.\n' "$version"
