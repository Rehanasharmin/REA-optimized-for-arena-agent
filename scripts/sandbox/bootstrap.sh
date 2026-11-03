#!/usr/bin/env bash
# REA sandbox bootstrap — the one command an agent runs before investigating.
#
#   bash scripts/sandbox/bootstrap.sh                 # make this sandbox ready
#   bash scripts/sandbox/bootstrap.sh --check         # instant status, no changes
#   bash scripts/sandbox/bootstrap.sh --with-native   # add Ghidra deep analysis
#   bash scripts/sandbox/bootstrap.sh --json          # machine-readable status
#
# `--check` is cheap and side-effect free (no npm, no network): it answers "can I
# analyse something right now, and what is missing?" so an agent can orient in one
# call instead of guessing. The default run provisions only what is missing,
# builds the runtime, then prints the exact commands to use.
#
# --check exit codes: 0 ready for engine-free work, 1 needs provisioning.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="bootstrap"
JSON=0
PASSTHROUGH=""

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check" ;;
    --json) JSON=1 ;;
    --help | -h)
      sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --with-native | --minimal | --no-apt | --no-build | --with-gdb | --with-browser)
      PASSTHROUGH="${PASSTHROUGH} $1"
      ;;
    *)
      echo "unknown option: $1 (try --help)" >&2
      exit 2
      ;;
  esac
  shift
done

cd "$REPO_ROOT"
export PATH="/usr/local/bin:${PATH}"

# ---------------------------------------------------------------- state probe

want_node="$(tr -d '[:space:]' < .nvmrc 2>/dev/null || echo unknown)"
have_node="$(node -v 2>/dev/null | sed 's/^v//' || echo absent)"
node_ok=0
[ "$have_node" = "$want_node" ] && node_ok=1

deps_ok=0
[ -d node_modules/typescript ] && deps_ok=1

runtime_ok=0
[ -f dist/cli-runtime/cli.js ] && runtime_ok=1

env_ok=0
[ -f .rea-sandbox.env ] && env_ok=1

# Engines can be installed without this shell having sourced the export file, so
# probe the conventional locations too.
jdk_home="${JAVA_HOME:-}"
if [ -z "$jdk_home" ]; then
  for candidate in /opt/rea-engines/jdk /usr/lib/jvm/java-2*-openjdk-amd64; do
    [ -x "${candidate}/bin/java" ] && jdk_home="$candidate" && break
  done
fi

ghidra_home="${GHIDRA_INSTALL_DIR:-}"
if [ -z "$ghidra_home" ]; then
  for candidate in /opt/rea-engines/ghidra_*; do
    [ -x "${candidate}/support/analyzeHeadless" ] && ghidra_home="$candidate"
  done
fi

jadx_jar="${REA_JADX_MCP_JAR:-}"
if [ -z "$jadx_jar" ] && [ -f /opt/rea-engines/jadx/jadx-headless-mcp-0.7.1-all.jar ]; then
  jadx_jar="/opt/rea-engines/jadx/jadx-headless-mcp-0.7.1-all.jar"
fi

pwntools_python="${REA_PWNTOOLS_PYTHON:-}"
if [ -z "$pwntools_python" ] && [ -x /opt/rea-engines/py/bin/python3 ]; then
  pwntools_python="/opt/rea-engines/py/bin/python3"
fi

android_ok=0
if [ -n "$jdk_home" ] && [ -n "$jadx_jar" ]; then android_ok=1; fi

engine_ok=0
if [ -n "$jdk_home" ] && [ -n "$ghidra_home" ]; then engine_ok=1; fi

ready=0
if [ "$node_ok" -eq 1 ] && [ "$deps_ok" -eq 1 ] && [ "$runtime_ok" -eq 1 ]; then
  ready=1
fi

status_line() {
  local label="$1" ok="$2" detail="$3"
  local state="missing"
  [ "$ok" -eq 1 ] && state="ok"
  printf '%-22s %-8s %s\n' "$label" "$state" "$detail"
}

if [ "$JSON" -eq 1 ]; then
  printf '{"ready":%s,"android_analysis":%s,"deep_analysis":%s,"node":{"ok":%s,"want":"%s","have":"%s"},"dependencies":%s,"runtime":%s,"env_file":%s,"jdk":"%s","jadx":"%s","ghidra":"%s","pwntools":"%s"}\n' \
    "$([ "$ready" -eq 1 ] && echo true || echo false)" \
    "$([ "$android_ok" -eq 1 ] && echo true || echo false)" \
    "$([ "$engine_ok" -eq 1 ] && echo true || echo false)" \
    "$node_ok" "$want_node" "$have_node" "$deps_ok" "$runtime_ok" "$env_ok" \
    "$jdk_home" "$jadx_jar" "$ghidra_home" "$pwntools_python"
fi

if [ "$MODE" = "check" ]; then
  if [ "$JSON" -eq 0 ]; then
    echo "REA sandbox status"
    status_line node "$node_ok" "want ${want_node}, have ${have_node}"
    status_line dependencies "$deps_ok" "node_modules/"
    status_line runtime "$runtime_ok" "dist/cli-runtime/cli.js"
    status_line env-file "$env_ok" ".rea-sandbox.env"
    status_line android-engines "$android_ok" "JDK 25 + apktool + jadx-headless-mcp"
    status_line deep-analysis "$engine_ok" "JDK 25 + Ghidra (optional)"
    echo
    if [ "$ready" -eq 1 ]; then
      if [ "$engine_ok" -eq 1 ]; then
        echo "READY: engine-free analysis + Ghidra deep analysis"
      else
        echo "READY: engine-free analysis (add Ghidra with --with-native)"
      fi
    else
      echo "NEEDS PROVISIONING: bash scripts/sandbox/bootstrap.sh"
    fi
  fi
  if [ "$ready" -eq 1 ]; then exit 0; else exit 1; fi
fi

needs_work=0
[ "$ready" -eq 1 ] && [ "$android_ok" -eq 1 ] || needs_work=1
case "$PASSTHROUGH" in
  *--with-native*) [ "$engine_ok" -eq 1 ] || needs_work=1 ;;
esac

if [ "$needs_work" -eq 1 ]; then
  echo "[bootstrap] provisioning (safe to re-run)"
  # shellcheck disable=SC2086 # word splitting is intended for the flag list
  bash scripts/sandbox/provision-sandbox.sh ${PASSTHROUGH}
else
  echo "[bootstrap] already provisioned"
fi

echo
if ! node scripts/sandbox/verify-sandbox.mjs --quick --no-color; then
  echo "[bootstrap] capability check reported failures; see the rows above" >&2
  exit 1
fi

cat <<'NEXT'

[bootstrap] ready
  set -a; . ./.rea-sandbox.env; set +a
  node scripts/rea.mjs analyze-javascript-application /abs/path/to/app --json
  node scripts/rea.mjs analyze /abs/path/to/binary --json     # needs --with-native

Agent instructions: AGENTS.md, docs/sandbox-environment.md
NEXT
