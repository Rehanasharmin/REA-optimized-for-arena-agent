#!/usr/bin/env bash
# REA sandbox provisioner — gets a disposable, headless Linux container ready to
# run the REA CLI.
#
# Default profile (fast, ~30-60 s once the npm cache is warm):
#   pinned Node.js, a swapfile when the host is short on RAM, the engine-free
#   host tools (binutils, file, zip, procps, sqlite3, tshark, apktool), the exact
#   pwntools/pyelftools/Unicorn virtualenv (pure-Python ELF parsing), the
#   `.rea-sandbox.env` export file, and a full runtime build.
#
# Deep-analysis profile (`--with-native`, several minutes cold):
#   adds a full 64-bit JDK 25 (REA's Ghidra gate) and Ghidra itself (~570 MB) for
#   decompilation. Nothing else changes.
#
# Every step is idempotent. Nothing outside `/opt/rea-engines` (or `--root`) and
# the gitignored `.rea-sandbox.env` is written; the target workspace is never
# modified.
#
# Usage:
#   bash scripts/sandbox/provision-sandbox.sh [options]
#
# Options:
#   --with-native            Also install JDK 25 + Ghidra for decompilation.
#   --minimal                Node.js, dependencies and build only.
#   --no-apt                 Skip every apt-get package.
#   --no-build               Skip `npm ci` and the runtime build.
#   --with-gdb               Also install gdb (ephemeral GDB console workflow).
#   --with-browser           Also install Chromium (Playwright capture paths).
#   --check                  Print the plan and current state; change nothing.
#   --root <dir>             Engine directory (default /opt/rea-engines).
#   --skip-set-default-java  Leave the system `java` alternative alone.
#   -h, --help               Show this help.
#
# Environment overrides: REA_SANDBOX_ROOT, GHIDRA_VERSION, NODE_VERSION.
#
# Exit codes: 0 success, 1 a required step failed, 2 usage error.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX_ROOT="${REA_SANDBOX_ROOT:-/opt/rea-engines}"
ENV_FILE="${REPO_ROOT}/.rea-sandbox.env"
WANT_NATIVE=0
WANT_TOOLS=1
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
usage() { sed -n '2,38p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --with-native) WANT_NATIVE=1 ;;
    --minimal)
      WANT_NATIVE=0
      WANT_TOOLS=0
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

mem_mib() { awk '/^MemTotal:/ {printf "%d\n", $2/1024}' /proc/meminfo; }
swap_mib() { awk '/^SwapTotal:/ {printf "%d\n", $2/1024}' /proc/meminfo; }
cpu_count() { getconf _NPROCESSORS_ONLN 2>/dev/null || printf '2\n'; }

# Heap cap for Node-based build tools: this sandbox class has ~2 GiB of RAM and
# no swap by default, so an unbounded tsc/rolldown run is OOM-killed.
node_heap_mib() {
  local heap
  heap=$(( $(mem_mib) * 6 / 10 ))
  [ "$heap" -gt 4096 ] && heap=4096
  [ "$heap" -lt 512 ] && heap=512
  printf '%s\n' "$heap"
}

find_ghidra() {
  local dir
  for dir in "${SANDBOX_ROOT}"/ghidra_*; do
    [ -x "${dir}/support/analyzeHeadless" ] && {
      printf '%s\n' "$dir"
      return 0
    }
  done
  return 1
}

find_jdk() {
  local candidate
  for candidate in /usr/lib/jvm/java-25-openjdk-amd64 \
    /usr/lib/jvm/java-26-openjdk-amd64 /usr/lib/jvm/java-27-openjdk-amd64; do
    [ -x "${candidate}/bin/java" ] && {
      printf '%s\n' "$candidate"
      return 0
    }
  done
  return 1
}

export PATH="/usr/local/bin:${PATH}"
step() { log "== $1"; }

# ---------------------------------------------------------------------- steps

ensure_swap() {
  step "swap"
  # `npm ci` re-materializes the whole dependency tree. Without swap that
  # allocation is OOM-killed mid-install and looks like a corrupt install.
  if [ "$(mem_mib)" -ge 4096 ] || [ "$(swap_mib)" -ge 1024 ]; then
    log "not needed ($(mem_mib) MiB RAM, $(swap_mib) MiB swap)"
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    log "would add a 2 GiB swapfile"
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
  log "swap available: $(swap_mib) MiB"
}

install_node() {
  step "node"
  local want have_version arch tarball url tmp
  want="$(tr -d '[:space:]' <"${REPO_ROOT}/.nvmrc" 2>/dev/null || true)"
  [ -n "$want" ] || want="${NODE_VERSION:-24.22.1}"
  have_version="$(node -v 2>/dev/null | sed 's/^v//' || true)"
  if [ "$have_version" = "$want" ]; then
    log "node ${want} already on PATH"
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    log "current node: ${have_version:-absent}; would install ${want} into /usr/local"
    return 0
  fi
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
  JDK_HOME_RESOLVED="$(find_jdk || true)"
  if [ -n "$JDK_HOME_RESOLVED" ]; then
    log "JDK home: ${JDK_HOME_RESOLVED}"
  elif [ "$WANT_NATIVE" -eq 0 ]; then
    log "skipped (engine-free profile; pass --with-native to add Ghidra)"
    return 0
  elif [ "$CHECK_ONLY" -eq 1 ]; then
    log "no JDK 25+ found; would apt-get install openjdk-25-jdk-headless"
    return 0
  else
    apt_install_optional openjdk-25-jdk-headless
    JDK_HOME_RESOLVED="$(find_jdk || true)"
    [ -n "$JDK_HOME_RESOLVED" ] && log "JDK home: ${JDK_HOME_RESOLVED}" ||
      warn "no JDK 25+ available; Ghidra will report unsupported_version"
  fi
  if [ -n "$JDK_HOME_RESOLVED" ] && [ "$SET_DEFAULT_JAVA" -eq 1 ] &&
    [ "$CHECK_ONLY" -eq 0 ] && have update-alternatives; then
    run_privileged update-alternatives --set java \
      "${JDK_HOME_RESOLVED}/bin/java" >/dev/null 2>&1 ||
      warn "could not repoint the default java alternative"
  fi
}

install_ghidra() {
  step "ghidra"
  GHIDRA_HOME_RESOLVED="$(find_ghidra || true)"
  if [ -n "$GHIDRA_HOME_RESOLVED" ]; then
    log "ghidra already extracted: ${GHIDRA_HOME_RESOLVED}"
    return 0
  fi
  if [ "$WANT_NATIVE" -eq 0 ]; then
    log "skipped (engine-free profile; pass --with-native to add Ghidra)"
    return 0
  fi
  local version="${GHIDRA_VERSION:-latest}" api url name tmp
  if [ "$CHECK_ONLY" -eq 1 ]; then
    log "would download Ghidra (${version}) into ${SANDBOX_ROOT}"
    return 0
  fi
  api="https://api.github.com/repos/NationalSecurityAgency/ghidra/releases/latest"
  [ "$version" = "latest" ] ||
    api="https://api.github.com/repos/NationalSecurityAgency/ghidra/releases/tags/${version}"
  url="$(curl -fsSL --max-time 120 "$api" |
    grep -o 'https://[^"]*_PUBLIC_[0-9]*\.zip' | head -1)"
  [ -n "$url" ] || {
    warn "could not resolve a Ghidra release archive; native analysis stays unavailable"
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
  GHIDRA_HOME_RESOLVED="$(find_ghidra || true)"
  [ -n "$GHIDRA_HOME_RESOLVED" ] || warn "ghidra layout not recognized after unzip"
}

install_pwntools() {
  step "pwntools"
  local venv="${SANDBOX_ROOT}/py"
  if [ -x "${venv}/bin/python3" ] &&
    "${venv}/bin/python3" -c 'import pwnlib, elftools, unicorn' >/dev/null 2>&1; then
    log "pwntools venv already ready: ${venv}"
    PWNTOOLS_PYTHON_RESOLVED="${venv}/bin/python3"
    return 0
  fi
  if [ "$WANT_TOOLS" -eq 0 ]; then
    log "skipped (--minimal)"
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
    PWNTOOLS_PYTHON_RESOLVED="${venv}/bin/python3"
    log "installed pwntools stack into ${venv}"
  else
    warn "pwntools install failed; inspect-binary-layout stays unavailable"
  fi
}

install_host_tools() {
  step "host-tools"
  if [ "$WANT_TOOLS" -eq 0 ]; then
    log "skipped (--minimal)"
    return 0
  fi
  local need=()
  have objdump || need+=(binutils)
  have file || need+=(file)
  have unzip || need+=(unzip)
  have zip || need+=(zip)
  have ps || need+=(procps)
  have sqlite3 || need+=(sqlite3)
  have tshark || need+=(tshark)
  have apktool || need+=(apktool)
  [ "$WANT_GDB" -eq 1 ] && { have gdb || need+=(gdb); }
  [ "$WANT_BROWSER" -eq 1 ] && { have chromium || need+=(chromium); }
  if [ ${#need[@]} -eq 0 ]; then
    log "all host tools already present"
    return 0
  fi
  apt_install_optional "${need[@]}"
  for tool in objdump file unzip ps sqlite3 tshark apktool; do
    have "$tool" || warn "missing optional tool: ${tool}"
  done
}

write_env_file() {
  step "env-file"
  local heap jdk ghidra pwn
  heap="$(node_heap_mib)"
  jdk="${JDK_HOME_RESOLVED:-${JAVA_HOME:-}}"
  ghidra="${GHIDRA_HOME_RESOLVED:-${GHIDRA_INSTALL_DIR:-}}"
  pwn="${PWNTOOLS_PYTHON_RESOLVED:-${REA_PWNTOOLS_PYTHON:-}}"
  if [ "$CHECK_ONLY" -eq 1 ]; then
    log "would write ${ENV_FILE}"
    return 0
  fi
  {
    printf '# Generated by scripts/sandbox/provision-sandbox.sh — machine specific.\n'
    printf '# Source before running REA:  set -a; . ./.rea-sandbox.env; set +a\n'
    printf 'PATH=%s\n' \
      "$(printf '%s' "/usr/local/bin:${PATH}" | tr ':' '\n' |
        awk '!seen[$0]++' | paste -sd:)"
    printf 'NODE_OPTIONS=--max-old-space-size=%s\n' "$heap"
    [ -n "$jdk" ] && printf 'JAVA_HOME=%s\n' "$jdk"
    [ -n "$ghidra" ] && printf 'GHIDRA_INSTALL_DIR=%s\n' "$ghidra"
    [ -n "$pwn" ] && printf 'REA_PWNTOOLS_PYTHON=%s\n' "$pwn"
    # Advertise WABT only when it is the exact build REA admits (1.0.42); the
    # distro package is older and an advertised-but-rejected toolchain produces
    # worse diagnostics than an unset variable.
    if have wasm-validate &&
      wasm-validate --version 2>/dev/null | grep -q '1[.]0[.]42'; then
      printf 'REA_WABT_BIN_DIRECTORY=%s\n' \
        "$(dirname "$(command -v wasm-validate)")"
    fi
    have apktool && printf 'REA_APKTOOL_COMMAND=%s\n' "$(command -v apktool)"
    have prlimit && printf 'REA_TSHARK_PRLIMIT_COMMAND=%s\n' "$(command -v prlimit)"
    [ "$WANT_BROWSER" -eq 1 ] && have chromium &&
      printf 'REA_BROWSER_EXECUTABLE=%s\n' "$(command -v chromium)"
    # Deep analysis on 2 vCPU: a generous startup deadline is patience, not a
    # hang; bounded decompile deadlines stop one function owning the turn.
    printf 'REA_GHIDRA_STARTUP_TIMEOUT_MS=600000\n'
    printf 'REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS=180\n'
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
  # Keep optional dependencies: @tsrs/linux-x64-gnu is an optionalDependency and
  # `--omit=optional` breaks the compile step.
  (cd "$REPO_ROOT" &&
    NODE_OPTIONS="--max-old-space-size=768" npm ci --fund=false --audit=false \
      --maxsockets=6 >/dev/null) || die "npm ci failed (see docs/sandbox-environment.md)"
  (cd "$REPO_ROOT" &&
    NODE_OPTIONS="--max-old-space-size=${heap}" npm run build:cached >/dev/null) ||
    die "npm run build:cached failed"
  log "runtime built: $(node -p "require('${REPO_ROOT}/package.json').version")"
}

summary() {
  local native_state="parsers + JavaScript/Electron analysis (no decompiler)"
  [ -n "${GHIDRA_HOME_RESOLVED:-}" ] &&
    native_state="parsers + JavaScript/Electron analysis + Ghidra ${GHIDRA_HOME_RESOLVED##*/} decompilation"
  printf '\n[rea-sandbox] ready\n'
  printf '  profile: %s\n' "$native_state"
  printf '  env:     %s\n' "$ENV_FILE"
  printf '\nNext:\n'
  printf '  set -a; . %s; set +a\n' "$ENV_FILE"
  printf '  node scripts/sandbox/verify-sandbox.mjs --quick\n'
  printf '  node scripts/rea.mjs analyze-javascript-application /abs/path/to/app --json\n'
}

main() {
  [ "$(uname -s)" = "Linux" ] || die "this provisioner targets Linux sandboxes"
  log "repo: $(uname -m) $(uname -s), $(cpu_count) vCPU, $(mem_mib) MiB RAM"
  [ "$CHECK_ONLY" -eq 1 ] && log "check mode: no changes will be made"
  JDK_HOME_RESOLVED=""
  GHIDRA_HOME_RESOLVED=""
  PWNTOOLS_PYTHON_RESOLVED=""

  ensure_swap
  install_node
  install_jdk
  install_ghidra
  install_pwntools
  install_host_tools
  write_env_file
  build_rea
  summary
}

main
