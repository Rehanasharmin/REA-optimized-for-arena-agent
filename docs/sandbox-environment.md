# REA in a headless agent sandbox

This page describes the **sandbox edition** of REA: the same tool, adapted to run
inside a disposable, headless Linux container that an AI agent drives through a
shell instead of an MCP-registered desktop client.

Everything below is either a machine-checked fact from
`node scripts/sandbox.mjs verify` or an explicit limit. It is written so an agent
can bootstrap, verify and investigate without outside help.

> REA is created and maintained by [morluto](https://github.com/morluto) and the
> REA contributors at [morluto/rea](https://github.com/morluto/rea). The engines,
> tool catalog, Evidence model and workflow skill are their work. This page and
> `scripts/sandbox/` are the fork's additions — see [CREDITS.md](../CREDITS.md).

## Environment profile

| Property       | Value                                                                   |
| -------------- | ----------------------------------------------------------------------- |
| OS / arch      | Debian 13 (trixie), Linux x86_64                                        |
| CPU / RAM      | 2 vCPU, ~2 GiB RAM, no swap by default                                  |
| Display        | none: no X11, no Wayland, no GUI applications                           |
| Package access | `apt-get`, `pip`, `npm`, passwordless `sudo`                            |
| Client         | no MCP registration; the CLI is the interface                           |
| Persistence    | only the workspace; `/opt`, installed packages and `node_modules` reset |
| Network        | outbound HTTPS available                                                |

The checkout is also **trimmed to fit an agent file budget**: ~3.2k files instead
of ~7.2k (see [File budget and slim profile](#file-budget-and-slim-profile)).

## One command for the sandbox

`scripts/sandbox.mjs` is the entire sandbox lifecycle in one dependency-free
file. It replaces the earlier `bootstrap.sh`, `verify-sandbox.mjs` and
`slim-repo.sh`.

| Command               | Purpose                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `status`              | Readiness report; changes nothing. `--json`, `--json <path>`, `--strict`.                      |
| `install`             | Provision what is missing and build. `--profile`, `--plan`, `--force`, `--no-verify`.          |
| `verify`              | Capability matrix against generated fixtures. `--quick`, `--all`, `--filter`, `--json <path>`. |
| `run`                 | Run the REA CLI with `.rea-sandbox.env` applied; forwards the exit status.                     |
| `batch`               | Many REA commands in one call with per-command timing and Evidence ids.                        |
| `slim`                | Trim the checkout to the agent file budget, or `--restore` it.                                 |
| `env`                 | Print, `--shell`, `--write` the derived environment.                                           |
| `report`              | Write the combined status + capability report.                                                 |
| `completions`, `help` | Shell completion and per-command help.                                                         |

```bash
node scripts/sandbox.mjs status                      # can I analyse right now?
node scripts/sandbox.mjs install                     # provision what is missing + build
node scripts/sandbox.mjs install --profile native    # also install JDK 25 + Ghidra
node scripts/sandbox.mjs run analyze /abs/path --json
```

### Replacing the old scripts

| Before                                                     | Now                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| `bash scripts/sandbox/bootstrap.sh --check`                | `node scripts/sandbox.mjs status`                      |
| `bash scripts/sandbox/bootstrap.sh`                        | `node scripts/sandbox.mjs install`                     |
| `bash scripts/sandbox/bootstrap.sh --with-native`          | `node scripts/sandbox.mjs install --profile native`    |
| `bash scripts/sandbox/provision-sandbox.sh`                | `node scripts/sandbox.mjs install --no-verify`         |
| `node scripts/sandbox/verify-sandbox.mjs --quick`          | `node scripts/sandbox.mjs verify --quick`              |
| `node scripts/sandbox/verify-sandbox.mjs --json <path>`    | `node scripts/sandbox.mjs verify --json <path>`        |
| `bash scripts/sandbox/slim-repo.sh [--dry-run\|--restore]` | `node scripts/sandbox.mjs slim [--dry-run\|--restore]` |
| `set -a; . ./.rea-sandbox.env; set +a`                     | automatic (or `node scripts/sandbox.mjs env --shell`)  |

`status` is free (no npm, no network, one process) and answers "can I analyse
something right now, and what is missing?" — use it as the first call in every
session, because the container resets. `--json` gives the same state as a
machine-readable document (`schema_version: 2`). It keeps the previous top-level
keys (`ready`, `android_analysis`, `deep_analysis`, `node`, `dependencies`,
`runtime`, `env_file`, `jdk`, `jadx`, `ghidra`, `pwntools`) and adds `host`,
`budget` and a `checks[]` array with a stable `id`, a boolean `ok`, a `detail`
string and a ready-to-run `hint` for every gap. `dependencies`, `runtime` and
`env_file` are booleans now, not `0`/`1`.

Two provisioning profiles:

| Profile                                                              | Command                    | Installs                                                                                                                                                    | Enables                                                                                                                                                                                   |
| -------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default (~60–90 s cold; ~2 s warm)                                   | `install`                  | pinned Node.js 24, swapfile, JDK 25, Apktool 3.x + `apksigner.jar`, `jadx-headless-mcp`, pwntools venv, optional host tools (`apt-get` if reachable), build | Android APK & React Native/Hermes analysis (JADX, Apktool, pure-TS signing & HBC), JavaScript/Electron analysis, deterministic parsers (`node:sqlite`, ELF/PE/Mach-O), ELF layout/symbols |
| Native (minutes: one ~570 MB Ghidra download, then cached in `/opt`) | `install --profile native` | adds Ghidra 12.x (~570 MB download, when GitHub release assets are reachable)                                                                               | native decompilation, function dossiers, call graphs, cross-references                                                                                                                    |

`--profile minimal|gdb|browser|full` covers the remaining combinations, and the
underlying `bash scripts/sandbox/provision-sandbox.sh` flags
(`--with-native`, `--no-apt`, `--no-build`, `--with-gdb`, `--with-browser`) still
pass through. Both profiles are idempotent and write only `/opt/rea-engines` and
the gitignored `.rea-sandbox.env`. A warm run reuses `node_modules` when it still
matches `package-lock.json`, so re-provisioning after a container reset is a
build-only pass until you pass `--reinstall`.

When Debian `apt` or `nodejs.org` mirrors are blocked by a sandbox egress
allowlist, `scripts/sandbox/lib/provision-allowed-engines.py` automatically
provisions Node.js, JDK 25 (`SourceLauncher` + `javac`), Apktool, and
`jadx-headless-mcp` from `registry.npmjs.org`, `pypi.org` /
`files.pythonhosted.org`, and `codeload.github.com`.

`.rea-sandbox.env` applies automatically: `scripts/rea.mjs` and
`sandbox run` read it before dispatch, explicit shell values win, and `PATH` only
gains entries it is missing. Sourcing it is optional and still works:

```bash
set -a; . ./.rea-sandbox.env; set +a
```

Set `REA_SANDBOX_ENV=<path>` to use another file, or `REA_SANDBOX_ENV=0` to
disable the behaviour. `node scripts/sandbox.mjs env --write` regenerates the
file from whatever is installed, without running the provisioner.

### Why the provisioner does what it does

1. **Node.js** — the pinned version from `.nvmrc` into `/usr/local`; the base image
   ships Node 20 and `package.json#engines` requires `^22.23.4 || ^24.22.1 || >=26.12.1`.
2. **Swap** — a 2 GiB swapfile when the host has under 4 GiB RAM and no swap.
   Without it `npm ci` is OOM-killed mid-install and looks like a corrupt
   dependency tree. `swapon` lives in `/sbin` and is not on an unprivileged
   `PATH`, so the provisioner resolves it explicitly rather than trusting
   `command -v`.
3. **JDK 25** — REA's Ghidra readiness check requires a **full 64-bit JDK 25 or
   newer**; the image's `java` is JDK 11 and JDK 21 is also rejected.
4. **Ghidra** — current public release, resolved from the GitHub API into
   `/opt/rea-engines`, exported as `GHIDRA_INSTALL_DIR`.
5. **pwntools** — a venv with the exact admitted versions (`pwntools 4.15.0`,
   `pyelftools 0.33`, `Unicorn 2.1.2`), exported as `REA_PWNTOOLS_PYTHON`, because
   REA never installs Python packages and the system interpreter is PEP 668-managed.
6. **Build** — `npm ci` (skipped while `node_modules` is newer than the lockfile;
   `--reinstall` forces it) with a bounded heap and socket count, then
   `npm run build:cached`, both capped by `NODE_OPTIONS=--max-old-space-size` and
   `REA_TS_MAX_MEMORY` (the TypeScript compiler's own heap bound).

### Cold start on a 2 GiB host

Measured from `git clone --depth 1` into a real disk path on 2 vCPU / 1,982 MiB RAM
with **no swap active** and an empty `node_modules`:

| Step                  | Result                                                              |
| --------------------- | ------------------------------------------------------------------- |
| `sandbox.mjs status`  | `NEEDS PROVISIONING` in well under 0.1 s (one process, no npm)      |
| `sandbox.mjs install` | `[sandbox] ready` in **42 s**, 11/12 capabilities, 0 failed         |
| `.rea-sandbox.env`    | `NODE_OPTIONS=--max-old-space-size=2014`, `REA_TS_MAX_MEMORY=2820M` |
| `sandbox.mjs status`  | `READY` (exit 0), only optional `deep-analysis` missing             |

A second `install` on the same host is a no-op ("already provisioned") and
finishes in ~2 s; `install --force` re-runs the provisioner, which still skips
`npm ci` while `node_modules` is newer than the lockfile.

Budgets are derived from the host, never hard-coded: the Node heap is 50% of
RAM+swap (floor 512 MiB, cap 4096 MiB) and the compiler bound is 70% (floor
1024 MiB, cap 3584 MiB, `M` suffix). Override the compiler bound with
`REA_TS_MAX_MEMORY` if you knowingly have more headroom. If the build still fails
the provisioner drops page cache and retries once at a 768 MiB heap /
1024 MiB compiler budget; if that fails too it prints RAM, swap and free disk
instead of a bare exit code. A workspace with under 2 GiB free gets a warning,
because some images mount it on a small tmpfs where the compile dies as `ENOSPC`.

## File budget and slim profile

An agent workspace has a file limit (10,000) and a size limit. A full REA
development checkout spends most of that budget on material that never runs during
an investigation, so `node scripts/sandbox.mjs slim` removes it deterministically:

| Removed                                                                                                     | Files | Why it is safe                                                                |
| ----------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------- |
| `tests/`                                                                                                    | 2,375 | Vitest suites, goldens and fixtures; not imported by `src/`                   |
| `src/**/*.test.ts`, `*.fixture.ts`                                                                          | 1,187 | Already excluded by `tsconfig.build.json`; nothing in production imports them |
| `website/`, `docs/readme/`                                                                                  | 121   | Documentation site and 23 translated READMEs                                  |
| `docs/assets` screenshots, `docs/releases`, `docs/specs`, `docs/design`, `docs/public`, `docs/verification` | ~200  | Regenerable or upstream-canonical; small SVGs used by the README were kept    |
| `.github/`, `.husky/`, release and lint tooling                                                             | ~80   | CI, hooks, mutation/coverage/knip/jscpd/release-please configs                |

Result: **7,154 → ~3,210 files** (about 33 MB without `.git`, 57 MB with it).
`src/`, `scripts/`, `bridge/`, `native/`, `third_party/`, `licenses/`, the
`docs/*.md` guides, the workflow skill and the sandbox tooling are untouched.

```bash
node scripts/sandbox.mjs slim --dry-run   # what would go (per-path file counts)
node scripts/sandbox.mjs slim --restore   # bring it back from git
node scripts/sandbox.mjs slim --json      # machine-readable before/after
```

Removing `.git` (24 MB) is safe if you never want the removed material back:
`rm -rf .git`.

## What works here (verified)

`node scripts/sandbox.mjs verify` re-derives this table on the host, and
`node scripts/sandbox.mjs report` writes both status and matrix to
`docs/sandbox-capability-report.json`. Probes run concurrently (4 in `--quick`,
2 once the Ghidra probes are included), so a quick pass costs roughly one CLI
start. Reference run on a registry-restricted Linux x86_64 host — **13/15
capabilities verified, 0 failed**:

| Capability                                                                                                                                                                                                             | Status       | Path / requirement                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| CLI, `--version`, `doctor`, `providers`                                                                                                                                                                                | works        | no engine needed                                                                                                            |
| Deterministic parsers (`inspect-byte-entropy`, `inspect-elf-notes`, `inspect-macho`, `inspect-plist`, `inspect-python-pyc`, `inspect-sqlite-database`, …)                                                              | works        | pure TypeScript + Node 24 built-in `node:sqlite` (no `sqlite3` CLI required)                                                |
| Archive/package inventory & mobile graphs (`inspect-artifact`, `extract-artifact`, `compare-artifacts`, `project-android-application-graph`)                                                                           | works        | pure TypeScript                                                                                                             |
| APK signatures & React Native Hermes bytecode (`inspect-apk-signature`, `inspect-hermes-bytecode`)                                                                                                                     | works        | pure TypeScript (APK v1/v2/v3 signing + Hermes HBC v59–v100+ headers, strings, functions, SHA-1 footer)                     |
| APK resources & manifest decoding (`inspect-apktool-client`, `decode-android-resources`)                                                                                                                               | works        | `REA_APKTOOL_COMMAND` (`/usr/local/bin/apktool` / `/opt/rea-engines/apktool`, default profile)                              |
| Android DEX / manifest / JNI / xref decompilation (`inspect-android-package`, `search-android-classes`, `inspect-android-class`, `inspect-android-method`, `inspect-android-jni-bindings`, `trace-android-references`) | works        | JDK 25 (`JAVA_HOME=/opt/rea-engines/jdk`) + `REA_JADX_MCP_JAR` (`/opt/rea-engines/jadx/jadx-headless-mcp-0.7.1-all.jar`)    |
| JavaScript / Electron static analysis (`analyze-javascript-application`, `trace-javascript-semantics`, `compare-application-versions`)                                                                                 | works        | no engine required — cheapest useful route                                                                                  |
| GNU objdump inspection (`inspect-with-objdump`)                                                                                                                                                                        | works        | `binutils`                                                                                                                  |
| ELF layout, symbols, relocations, mitigations (`inspect-binary-layout`)                                                                                                                                                | works        | `REA_PWNTOOLS_PYTHON` venv (default profile)                                                                                |
| Managed (.NET) static inspection                                                                                                                                                                                       | works        | pure TypeScript                                                                                                             |
| Ghidra deep analysis (`analyze`, `function`, `decompile`, `xrefs`, `search`)                                                                                                                                           | needs config | `--with-native` profile when `objects.githubusercontent.com` is reachable                                                   |
| Packet captures (`inspect-pcap-capture`, `inspect-packet-fields`)                                                                                                                                                      | needs config | requires `tshark` 4.4 (`apt-get` when Debian mirrors are reachable)                                                         |
| WASM inspection (`inspect-wasm-artifact`)                                                                                                                                                                              | needs config | requires WABT **1.0.42**; the distro build is 1.0.36, so the provisioner deliberately leaves `REA_WABT_BIN_DIRECTORY` unset |

## What stays unavailable, and why

These are limits of the environment, not defects to work around:

| Capability                                   | Reason                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Hopper provider                              | macOS-only. On Linux REA reports `executable_missing` for `/opt/hopper/bin/Hopper`.                                                          |
| IDA, JEB, Kuna providers                     | Commercial tools supplied by the caller (`REA_IDA_MCP_CONFIG`, `REA_JEB_MCP_URL`, `REA_KUNA_COMMAND`). REA grants no license or entitlement. |
| ADB device workflows                         | No device or emulator in the container.                                                                                                      |
| Browser capture                              | Needs a Chromium build (`--with-browser`) and a reachable page; heavy for 2 vCPU.                                                            |
| Frida / LLDB / native UI runtime observation | No target process to attach to, no macOS accessibility APIs, ptrace blocked in the default sandbox profile.                                  |
| Firmware extraction                          | Pinned to Binwalk **3.1.x** (Debian ships 2.4.3) or Unblob **26.6.x**.                                                                       |
| `rea setup` client registration              | There is no client to configure; the skill is consumed as repository documentation and `doctor` reports `skill:identity` as missing.         |

## Resource discipline

| Knob                                   | Value                                | Why                                                    |
| -------------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| `NODE_OPTIONS`                         | `--max-old-space-size` ≈ 50 % of RAM | keeps builds inside the cgroup                         |
| `REA_GHIDRA_STARTUP_TIMEOUT_MS`        | `600000`                             | a cold import that takes minutes is normal, not a hang |
| `REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS` | `180`                                | one function cannot own the turn                       |
| `REA_MCP_MAX_RESPONSE_BYTES`           | `10485760`                           | REA's floor; retained Evidence keeps the full record   |

- **One heavy job at a time.** Two concurrent Ghidra imports exhaust RAM, so
  `sandbox batch` serializes native commands automatically (concurrency 1); light
  commands default to 2.
- **Do not reinstall casually.** Prefer `npm run build:cached`; `npm ci` needs the
  swapfile.
- **Price output before reading it.** `--token-count`, `--token-limit`,
  `--filter-output`, `--format md|toon`; keep JSON for records a later call reads.
- **Reuse the warm session.** `--snapshot <dir>` and retained Evidence avoid paying
  for the same import twice; `evidence-export` persists a bundle into the workspace.

## Troubleshooting ladder

| Observed result                                                                          | Meaning                                                         | Action                                                                                                                                       |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox.mjs status` says `NEEDS PROVISIONING`                                           | container reset or first use                                    | `node scripts/sandbox.mjs install`                                                                                                           |
| `unsupported_version … JDK 25 or newer`                                                  | `JAVA_HOME` points at JDK 11/21                                 | re-run `install`; confirm `JAVA_HOME=/opt/rea-engines/jdk` (or `/usr/lib/jvm/java-25-openjdk-amd64`), or `env --write` to regenerate exports |
| `GHIDRA_INSTALL_DIR is not set`                                                          | deep-analysis profile not installed, or the env file is missing | `install --profile native`, then `env --write` (REA also loads `.rea-sandbox.env` itself)                                                    |
| `provider_unavailable` with all candidates rejected                                      | nothing configured for that route                               | read `details.rejections[]` (`code`, `reason`, `remediation`); do not retry unchanged                                                        |
| `Selected Python lacks pwntools 4.15.0`                                                  | `REA_PWNTOOLS_PYTHON` points at another interpreter             | point it at `/opt/rea-engines/py/bin/python3`                                                                                                |
| `npm ci` exits with `Killed`                                                             | OOM killer                                                      | confirm swap (`free -m`), retry with `--maxsockets=6`                                                                                        |
| `Killed` during `npm run build`                                                          | heap above available RAM                                        | `NODE_OPTIONS=--max-old-space-size=1024` and rebuild                                                                                         |
| `rea doctor` reports `hopper`, `ghidra`, `ida-registration`, `kuna-installation` missing | expected                                                        | optional/caller-supplied integrations; `jadx` is healthy once `.rea-sandbox.env` is sourced                                                  |
| `Unsupported wasm-validate version banner`                                               | WABT pin mismatch                                               | install WABT 1.0.42 or leave WASM unadvertised                                                                                               |
| `oxlint` aborts (`oxc_allocator … fixed_size.rs`)                                        | bundled lint binary is incompatible with this container         | the slim profile ships no lint gate; use `npm run typecheck`, `npm run verify:module-boundaries`, `npm run sandbox:check`                    |

## Contributing back

Fixes that are genuinely general — readiness messages, engine detection,
memory-aware defaults, Evidence provenance — belong upstream at
[morluto/rea](https://github.com/morluto/rea) under
[CONTRIBUTING.md](../CONTRIBUTING.md). Restore the development tree first
(`node scripts/sandbox.mjs slim --restore`) or clone upstream, so the upstream
gates can run. Keep sandbox-specific changes in `scripts/sandbox.mjs`,
`scripts/sandbox/`,
`docs/sandbox-environment.md`, `CREDITS.md` and the environment sections of
`AGENTS.md` and `.agents/skills/`, so upstream diffs stay reviewable.
