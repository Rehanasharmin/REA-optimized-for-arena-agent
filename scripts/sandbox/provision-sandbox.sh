#!/usr/bin/env bash
# REA sandbox provisioner.
#
# Brings a disposable, headless Linux x64 agent sandbox (no GUI, no package
# manager for Node, no preinstalled analysis engines) up to a state where the
# REA CLI can run its engine-free workflows and, when the native extras are
# enabled, its Ghidra-backed native workflows.
#
# Every step is idempotent and skippable. Nothing outside the directories named
# below is modified: the provisioner never edits the target project, never
# upgrades unrelated software, and never writes into the repository except for
# the gitignored `.rea-sandbox.env` export file.
#
# Usage:
#   bash scripts/sandbox/provision-sandbox.sh [options]
#
# Options:
#   --minimal           Node.js + npm dependencies + build only (no engines).
#   --no-native         Skip the native analysis engines (Ghidra, JDK, pwntools).
#   --no-apt            Skip every apt-get package.
#   --no-build          Skip `npm ci` and the runtime build.
#   --with-gdb          Also install gdb for the ephemeral GDB console workflow.
#   --with-browser      Also install Chromium for the Playwright capture paths.
#   --check             Report the plan and current state; change nothing.
#   --root <dir>        Root for provisioned engines (default /opt/rea-engines).
#   --skip-set-default-java  Do not repoint the system `java` alternative.
#   -h, --help          Show this help.
#
# Environment overrides:
#   REA_SANDBOX_ROOT    Same as --root.
#   GHIDRA_VERSION      Ghidra release tag to install (default: latest release).
#   NODE_VERSION        Node.js version to install (default: .nvmrc).
#
# Exit codes: 0 success, 1 a required step failed, 2 usage error.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX_ROOT="${REA_SANDBOX_ROOT:-/opt/rea-engines}"
ENV_FILE="${REPO_ROOT}/.rea-sandbox.env"
GHIDRA_MIN_VERSION="12.1"
WANT_NATIVE=1
WANT_APT=1
WANT_BUILD=1
WANT_GDB=0
WANT_BROWSER=0
CHECK_ONLY=0
SET_DEFAULT_JAVA=1

log() { printf '[rea-sandbox] %s\n' "$*"; }
warn() { printf '[rea-sandbox] warning: %s\n' "$*" >&2; }
die() {
  printf '[rea-sandbox] error: %s\n' "$*" >&2
  exit 1
}

usage() { sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --minimal)
      WANT_NATIVE=0
      ;;
    --no-native) WANT_NATIVE=0 ;;
    --no-apt) WANT_APT=0 ;;
    --no-build) WANT_BUILD=0 ;;
    --with-gdb) WANT_GDB=1 ;;
    --with-browser) WANT_BROWSER=1 ;;
    --check) CHECK_ONLY=1 ;;
    --root)
      SANDBOX_ROOT="${2:?--root needs a directory}"
      shift
      ;;
    --skip-set-default-java) SET_DEFAULT_JAVA=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

# ---------------------------------------------------------------- environment

run_privileged() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo -n "$@"
  else
    die "need root or passwordless sudo to run: $*"
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

# Non-interactive apt with our own quiet flags; failures are reported, not fatal
# for optional tooling.
apt_install_optional() {
  [ "$WANT_APT" -eq 1 ] || return 0
  local packages=("$@")
  if [ "$CHECK_ONLY" -eq 1 ]; then
    log "would apt-get install: ${packages[*]}"
    return 0
  fi
  DEBIAN_FRONTEND=noninteractive run_privileged apt-get install -y -q \
    -o Dpkg::Options::=--force-confold "${packages[@]}" >/dev/null 2>&1 ||
    warn "apt-get install failed for: ${packages[*]} (optional; continuing)"
}

mem_mib() {
  if [ -r /proc/meminfo ]; then
    awk '/^MemTotal:/ {printf "%d\n", $2/1024}' /proc/meminfo
  else
    printf '2048\n'
  fi
}

cpu_count() { getconf _NPROCESSORS_ONLN 2>/dev/null || printf '2\n'; }

# Heap cap for build steps: this sandbox class has ~2 GiB of RAM and no swap, so
# an unbounded tsc/rolldown run gets OOM-killed instead of failing usefully.
node_heap_mib() {
  local total heap
  total="$(mem_mib)"
  heap=$((total * 6 / 10))
  [ "$heap" -gt 4096 ] && heap=4096
  [ "$heap" -lt 512 ] && heap=512
  printf '%s\n' "$heap"
}

export PATH="/usr/local/bin:${PATH}"

# ---------------------------------------------------------------------- step 1

step() { log "== $1"; }

install_node() {
  step "node"
  local want have_version
  want="$(tr -d '[:space:]' <"${REPO_ROOT}/.nvmrc" 2>/dev/null || true)"
  [ -n "$want" ] || want="${NODE_VERSION:-24.22.1}"
  have_version="$(node -v 2>/dev/null | sed 's/^v//' || true)"
  if [ "$have_version" = "$want" ]; then
    log "node ${want} already on PATH"
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    log "current node: ${have_version:-absent}; would install node ${want} into /usr/local"
    return 0
  fi
  local arch tarball url tmp
  case "$(uname -m)" in
    x86_64) arch="x64" ;;
    aarch64 | arm64) arch="arm64" ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
  tarball="node-v${want}-linux-${arch}.tar.xz"
  url="https://nodejs.org/dist/v${want}/${tarball}"
  tmp="$(mktemp -d)"
  log "installing node ${want} (${arch}) into /usr/local"
  curl -fsSL --max-time 600 -o "${tmp}/${tarball}" "$url" ||
    die "node download failed: $url"
  run_privileged tar -xJf "${tmp}/${tarball}" -C /usr/local --strip-components=1
  rm -rf "$tmp"
  hash -r
  [ "$(node -v | sed 's/^v//')" = "$want" ] || die "node install did not take effect"
}

install_jdk() {
  step "jdk"
  # REA's Ghidra readiness check requires a full 64-bit JDK 25 or newer. The
  # distro default `java` in this image is JDK 11, which fails that check.
  local jdk_home=""
  for candidate in /usr/lib/jvm/java-25-openjdk-amd64 /usr/lib/jvm/java-26-openjdk-amd64; do
    if [ -x "${candidate}/bin/java" ]; then
      jdk_home="$candidate"
      break
    fi
  done
  if [ -z "$jdk_home" ]; then
    if [ $WANT_NATIVE -eq 0 ]; then
      log "skipped (native engines disabled)"
      return 0
    fi
    if [ "$CHECK_ONLY" -eq 1 ]; then
      log "no JDK 25+ found; would apt-get install openjdk-25-jdk-headless"
      return 0
    fi
    apt_install_optional openjdk-25-jdk-headless
    for candidate in /usr/lib/jvm/java-25-openjdk-amd64 /usr/lib/jvm/java-26-openjdk-amd64; do
      [ -x "${candidate}/bin/java" ] && jdk_home="$candidate"
    done
  fi
  [ -n "$jdk_home" ] || {
    warn "no JDK 25+ available; Ghidra workflows will report unsupported_version"
    return 0
  }
  log "JDK home: ${jdk_home}"
  if [ "$SET_DEFAULT_JAVA" -eq 1 ] && [ "$CHECK_ONLY" -eq 0 ] &&
    have update-alternatives; then
    run_privileged update-alternatives --set java "${jdk_home}/bin/java" \
      >/dev/null 2>&1 || warn "could not repoint the default java alternative"
  fi
  JDK_HOME_RESOLVED="$jdk_home"
}

install_ghidra() {
  step "ghidra"
  if [ $WANT_NATIVE -eq 0 ]; then
    log "skipped (native engines disabled)"
    return 0
  fi
  local existing=""
  for dir in "${SANDBOX_ROOT}"/ghidra_*; do
    [ -x "${dir}/support/analyzeHeadless" ] && existing="$dir"
  done
  if [ -n "$existing" ]; then
    log "ghidra already extracted: ${existing}"
    GHIDRA_HOME_RESOLVED="$existing"
    return 0
  fi
  local version="${GHIDRA_VERSION:-latest}"
  if [ "$CHECK_ONLY" -eq 1 ]; then
    log "would download Ghidra (${version}) into ${SANDBOX_ROOT}"
    return 0
  fi
  local api="https://api.github.com/repos/NationalSecurityAgency/ghidra/releases/latest"
  [ "$version" = "latest" ] || api="https://api.github.com/repos/NationalSecurityAgency/ghidra/releases/tags/${version}"
  local url name tmp
  url="$(curl -fsSL --max-time 120 "$api" |
    grep -o 'https://[^"]*_PUBLIC_[0-9]*\.zip' | head -1)"
  [ -n "$url" ] || {
    warn "could not resolve a Ghidra release archive; native deep analysis stays unavailable"
    return 0
  }
  tmp="$(mktemp -d)"
  name="$(basename "$url")"
  log "downloading ${name} (~570 MB, one time)"
  curl -fL --max-time 1800 -o "${tmp}/${name}" "$url" || {
    warn "ghidra download failed"
    rm -rf "$tmp"
    return 0
  }
  run_privileged mkdir -p "$SANDBOX_ROOT"
  run_privileged unzip -q "${tmp}/${name}" -d "$SANDBOX_ROOT" || {
    warn "ghidra unzip failed"
    rm -rf "$tmp"
    return 0
  }
  rm -rf "$tmp"
  for dir in "${SANDBOX_ROOT}"/ghidra_*; do
    [ -x "${dir}/support/analyzeHeadless" ] && GHIDRA_HOME_RESOLVED="$dir"
  done
  [ -n "${GHIDRA_HOME_RESOLVED:-}" ] || warn "ghidra layout not recognized after unzip"
}

install_pwntools() {
  step "pwntools"
  if [ $WANT_NATIVE -eq 0 ]; then
    log "skipped (native engines disabled)"
    return 0
  fi
  # REA pins unchanged pwntools 4.15.0 / pyelftools 0.33 / Unicorn 2.1.2 and
  # refuses to install Python packages itself, so the sandbox keeps them in a
  # dedicated venv instead of mutating the system interpreter.
  local venv="${SANDBOX_ROOT}/py"
  if [ -x "${venv}/bin/python3" ] && "${venv}/bin/python3" -c \
    'import pwnlib, elftools, unicorn' >/dev/null 2>&1; then
    log "pwntools venv already ready: ${venv}"
    REA_PWNTOOLS_PYTHON_RESOLVED="${venv}/bin/python3"
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    log "would create ${venv} with pwntools 4.15.0, pyelftools 0.33, unicorn 2.1.2"
    return 0
  fi
  run_privileged mkdir -p "$SANDBOX_ROOT"
  if [ ! -x "${venv}/bin/python3" ]; then
    run_privileged python3 -m venv "$venv" >/dev/null 2>&1 ||
      python3 -m venv "$venv" >/dev/null 2>&1 || {
      warn "could not create a venv; inspect-binary-layout stays unavailable"
      return 0
    }
  fi
  if run_privileged "${venv}/bin/pip" install -q --root-user-action=ignore \
    pwntools==4.15.0 pyelftools==0.33 unicorn==2.1.2 >/dev/null 2>&1 ||
    "${venv}/bin/pip" install -q --root-user-action=ignore \
      pwntools==4.15.0 pyelftools==0.33 unicorn==2.1.2 >/dev/null 2>&1; then
    REA_PWNTOOLS_PYTHON_RESOLVED="${venv}/bin/python3"
    log "installed pwntools stack into ${venv}"
  else
    warn "pwntools install failed; inspect-binary-layout stays unavailable"
  fi
}

install_host_tools() {
  step "host-tools"
  # binutils/file/zip/ps cover the engine-free inspection paths; tshark,
  # apktool and wabt back the packet-capture, APK-resource and WASM paths.
  local need=()
  have objdump || need+=(binutils)
  have file || need+=(file)
  have unzip || need+=(unzip)
  have zip || need+=(zip)
  have ps || need+=(procps)
  have tshark || need+=(tshark)
  have apktool || need+=(apktool)
  have sqlite3 || need+=(sqlite3)
  [ "$WANT_GDB" -eq 1 ] && { have gdb || need+=(gdb); }
  # Chromium backs the Playwright capture tools; it is large, so it is opt-in.
  [ "$WANT_BROWSER" -eq 1 ] && { have chromium || need+=(chromium); }
  if [ ${#need[@]} -eq 0 ]; then
    log "all host tools already present"
    return 0
  fi
  apt_install_optional "${need[@]}"
  for tool in objdump file unzip ps tshark apktool sqlite3; do
    have "$tool" || warn "missing optional tool: ${tool}"
  done
}

ensure_swap() {
  step "swap"
  # This sandbox class runs ~2 GiB with no swap. `npm ci` re-materializes the
  # whole tree and gets OOM-killed mid-install ("Killed" with no npm error),
  # which then looks like a corrupted dependency install. A transient swapfile
  # is cheap insurance; it is not required when the host already has swap.
  local total available_swap
  total="$(mem_mib)"
  available_swap="$(awk '/^SwapTotal:/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || printf '0')"
  if [ "$total" -ge 4096 ] || [ "$available_swap" -ge 1024 ]; then
    log "not needed (${total} MiB RAM, ${available_swap} MiB swap)"
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    log "would add a 2 GiB swapfile (host has ${total} MiB RAM, ${available_swap} MiB swap)"
    return 0
  fi
  if have swapon && [ ! -e /swapfile ]; then
    run_privileged fallocate -l 2G /swapfile >/dev/null 2>&1 ||
      run_privileged dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none >/dev/null 2>&1 ||
      warn "could not allocate a swapfile; installs stay memory-sensitive"
    if [ -e /swapfile ]; then
      run_privileged chmod 600 /swapfile >/dev/null 2>&1 || true
      run_privileged mkswap /swapfile >/dev/null 2>&1 || true
      run_privileged swapon /swapfile >/dev/null 2>&1 ||
        warn "swapon refused; installs stay memory-sensitive"
    fi
  fi
  available_swap="$(awk '/^SwapTotal:/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || printf '0')"
  log "swap available: ${available_swap} MiB"
}

write_env_file() {
  step "env-file"
  local heap jdk ghidra pwn
  heap="$(node_heap_mib)"
  jdk="${JDK_HOME_RESOLVED:-${JAVA_HOME:-}}"
  ghidra="${GHIDRA_HOME_RESOLVED:-${GHIDRA_INSTALL_DIR:-}}"
  pwn="${REA_PWNTOOLS_PYTHON_RESOLVED:-${REA_PWNTOOLS_PYTHON:-}}"
  if [ "$CHECK_ONLY" -eq 1 ]; then
    log "would write ${ENV_FILE}"
    return 0
  fi
  {
    printf '# Generated by scripts/sandbox/provision-sandbox.sh — machine specific.\n'
    printf '# Source it before running REA:  set -a; . ./.rea-sandbox.env; set +a\n'
    # Deduplicate PATH: repeated provisions must not grow it without bound.
    printf 'PATH=%s\n' \
      "$(printf '%s' "/usr/local/bin:${PATH}" | tr ':' '\n' |
        awk '!seen[$0]++' | paste -sd:)"
    printf 'NODE_OPTIONS=--max-old-space-size=%s\n' "$heap"
    [ -n "$jdk" ] && printf 'JAVA_HOME=%s\n' "$jdk"
    [ -n "$ghidra" ] && printf 'GHIDRA_INSTALL_DIR=%s\n' "$ghidra"
    [ -n "$pwn" ] && printf 'REA_PWNTOOLS_PYTHON=%s\n' "$pwn"
    # Only advertise WABT when it is the exact build REA admits. The distro
    # package is older (1.0.36 vs the required 1.0.42), and an advertised but
    # rejected toolchain reports worse diagnostics than an unset variable.
    if have wasm-validate &&
      wasm-validate --version 2>/dev/null | grep -q '1[.]0[.]42'; then
      printf 'REA_WABT_BIN_DIRECTORY=%s\n' \
        "$(dirname "$(command -v wasm-validate)")"
    fi
    if have apktool; then
      printf 'REA_APKTOOL_COMMAND=%s\n' "$(command -v apktool)"
    fi
    if have prlimit; then
      printf 'REA_TSHARK_PRLIMIT_COMMAND=%s\n' "$(command -v prlimit)"
    fi
    if [ "$WANT_BROWSER" -eq 1 ] && have chromium; then
      printf 'REA_BROWSER_EXECUTABLE=%s\n' "$(command -v chromium)"
    fi
    # Deep analysis on 2 vCPU / 2 GiB: give Ghidra a generous startup deadline
    # and keep per-call decompile deadlines bounded so one function cannot own
    # the whole turn.
    printf 'REA_GHIDRA_STARTUP_TIMEOUT_MS=600000\n'
    printf 'REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS=180\n'
    # Keep agent-visible payloads small: REA floors this at 10 MiB; retained
    # Evidence still holds the complete record in-session.
    printf 'REA_MCP_MAX_RESPONSE_BYTES=10485760\n'
  } >"$ENV_FILE"
  log "wrote ${ENV_FILE}"
}

build_rea() {
  step "build"
  local heap
  heap="$(node_heap_mib)"
  if [ "$WANT_BUILD" -eq 0 ]; then
    log "skipped (--no-build)"
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    log "would run: npm ci && npm run build:cached (heap ${heap} MiB)"
    return 0
  fi
  # `npm ci` must keep optional dependencies: @tsrs/linux-x64-gnu and the
  # platform binaries are optionalDependencies, and --omit=optional breaks the
  # compile step with "Cannot find the optional dependency @tsrs/linux-x64-gnu".
  # npm itself is a Node process: cap its heap and socket fan-out so the
  # install cannot walk into the OOM killer on a 2 GiB host.
  (cd "$REPO_ROOT" &&
    NODE_OPTIONS="--max-old-space-size=768" npm ci --fund=false --audit=false \
      --maxsockets=6) ||
    die "npm ci failed (rerun with more memory or a larger swapfile)"
  (cd "$REPO_ROOT" &&
    NODE_OPTIONS="--max-old-space-size=${heap}" npm run build:cached) ||
    die "npm run build:cached failed"
}

summary() {
  printf '\n[rea-sandbox] done\n'
  printf '  repo:    %s\n' "$REPO_ROOT"
  printf '  engines: %s\n' "$SANDBOX_ROOT"
  printf '  env:     %s\n' "$ENV_FILE"
  printf '\nNext:\n'
  printf '  set -a; . %s; set +a\n' "$ENV_FILE"
  printf '  node scripts/rea.mjs doctor --json\n'
  printf '  node scripts/sandbox/verify-sandbox.mjs\n'
}

main() {
  [ "$(uname -s)" = "Linux" ] || die "this provisioner targets Linux sandboxes"
  log "repo: $(uname -m) $(uname -s), $(cpu_count) vCPU, $(mem_mib) MiB RAM"
  [ "$CHECK_ONLY" -eq 1 ] && log "check mode: no changes will be made"

  ensure_swap
  install_node
  JDK_HOME_RESOLVED=""
  GHIDRA_HOME_RESOLVED=""
  REA_PWNTOOLS_PYTHON_RESOLVED=""
  install_jdk
  install_ghidra
  install_pwntools
  install_host_tools
  write_env_file
  build_rea
  summary
}

main
