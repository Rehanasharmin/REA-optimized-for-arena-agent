# REA in a headless agent sandbox

This page describes the **sandbox edition** of REA: the same tool, adapted to run
inside a disposable, headless Linux container that an AI agent drives through a
shell instead of an MCP-registered desktop client.

Everything below is either a machine-checked fact from
`node scripts/sandbox/verify-sandbox.mjs` or an explicit limit. It is written so an
agent can bootstrap, verify and investigate without outside help.

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

## Bootstrap (one command)

```bash
bash scripts/sandbox/bootstrap.sh --check          # instant status, changes nothing
bash scripts/sandbox/bootstrap.sh                  # provision what is missing + build
bash scripts/sandbox/bootstrap.sh --with-native    # also install JDK 25 + Ghidra
```

`--check` is free (no npm, no network) and answers "can I analyse something right
now, and what is missing?" — use it as the first call in every session, because
the container resets. `--json` gives the same state as machine-readable JSON.

Two provisioning profiles:

| Profile                                | Command                      | Installs                                                                                        | Enables                                                                                                       |
| -------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Default (fast, ~30-60 s warm)          | `bootstrap.sh`               | pinned Node.js, swapfile, binutils/file/zip/procps/sqlite3/tshark/apktool, pwntools venv, build | JavaScript/Electron analysis, every deterministic parser, archive/APK/PCAP inspection, ELF layout and symbols |
| Native (`--with-native`, minutes cold) | `bootstrap.sh --with-native` | adds full JDK 25 and Ghidra 12.x (~570 MB download)                                             | decompilation, function dossiers, call graphs, cross-references                                               |

Both profiles are idempotent and write only `/opt/rea-engines` and the gitignored
`.rea-sandbox.env`. Load the exports in each shell before running REA:

```bash
set -a; . ./.rea-sandbox.env; set +a
```

### Why the provisioner does what it does

1. **Node.js** — the pinned version from `.nvmrc` into `/usr/local`; the base image
   ships Node 20 and `package.json#engines` requires `^22.23.4 || ^24.22.1 || >=26.12.1`.
2. **Swap** — a 2 GiB swapfile when the host has under 4 GiB RAM and no swap.
   Without it `npm ci` is OOM-killed mid-install and looks like a corrupt
   dependency tree.
3. **JDK 25** — REA's Ghidra readiness check requires a **full 64-bit JDK 25 or
   newer**; the image's `java` is JDK 11 and JDK 21 is also rejected.
4. **Ghidra** — current public release, resolved from the GitHub API into
   `/opt/rea-engines`, exported as `GHIDRA_INSTALL_DIR`.
5. **pwntools** — a venv with the exact admitted versions (`pwntools 4.15.0`,
   `pyelftools 0.33`, `Unicorn 2.1.2`), exported as `REA_PWNTOOLS_PYTHON`, because
   REA never installs Python packages and the system interpreter is PEP 668-managed.
6. **Build** — `npm ci` with a bounded heap and socket count, then
   `npm run build:cached`, both capped by `NODE_OPTIONS=--max-old-space-size`.

## File budget and slim profile

An agent workspace has a file limit (10,000) and a size limit. A full REA
development checkout spends most of that budget on material that never runs during
an investigation, so `scripts/sandbox/slim-repo.sh` removes it deterministically:

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
bash scripts/sandbox/slim-repo.sh --dry-run   # what would go
bash scripts/sandbox/slim-repo.sh --restore   # bring it back from git
```

Removing `.git` (24 MB) is safe if you never want the removed material back:
`rm -rf .git`.

## What works here (verified)

`node scripts/sandbox/verify-sandbox.mjs` re-derives this table on the host and
writes `docs/sandbox-capability-report.json`. Reference run — **13/14
capabilities verified, 0 failed**:

| Capability                                                                                                                                                | Status       | Path / requirement                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| CLI, `--version`, `doctor`, `providers`                                                                                                                   | works        | no engine needed                                                                                                            |
| Deterministic parsers (`inspect-byte-entropy`, `inspect-elf-notes`, `inspect-macho`, `inspect-plist`, `inspect-python-pyc`, `inspect-sqlite-database`, …) | works        | pure TypeScript                                                                                                             |
| Archive/package inventory (`inspect-artifact`, `extract-artifact`, `compare-artifacts`)                                                                   | works        | pure TypeScript                                                                                                             |
| JavaScript / Electron static analysis (`analyze-javascript-application`, `trace-javascript-semantics`, `compare-application-versions`)                    | works        | no engine required — cheapest useful route                                                                                  |
| GNU objdump inspection (`inspect-with-objdump`)                                                                                                           | works        | `binutils`                                                                                                                  |
| ELF layout, symbols, relocations, mitigations (`inspect-binary-layout`)                                                                                   | works        | `REA_PWNTOOLS_PYTHON` venv (default profile)                                                                                |
| Packet captures (`inspect-pcap-capture`, `inspect-packet-fields`)                                                                                         | works        | `tshark` 4.4                                                                                                                |
| APK declarations and resources (`inspect-apktool-client`, `inspect-android-package`, `decode-android-resources`)                                          | works        | `apktool` 2.7.0                                                                                                             |
| Managed (.NET) static inspection                                                                                                                          | works        | pure TypeScript                                                                                                             |
| Ghidra deep analysis (`analyze`, `function`, `decompile`, `xrefs`, `search`)                                                                              | works        | `--with-native` profile; ~14 s cold import for a small ELF                                                                  |
| WASM inspection (`inspect-wasm-artifact`)                                                                                                                 | needs config | requires WABT **1.0.42**; the distro build is 1.0.36, so the provisioner deliberately leaves `REA_WABT_BIN_DIRECTORY` unset |

## What stays unavailable, and why

These are limits of the environment, not defects to work around:

| Capability                                   | Reason                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Hopper provider                              | macOS-only. On Linux REA reports `executable_missing` for `/opt/hopper/bin/Hopper`.                                                          |
| IDA, JEB, Kuna providers                     | Commercial tools supplied by the caller (`REA_IDA_MCP_CONFIG`, `REA_JEB_MCP_URL`, `REA_KUNA_COMMAND`). REA grants no license or entitlement. |
| JADX-backed Android code                     | Requires a caller-supplied `jadx-headless-mcp` JAR (`REA_JADX_MCP_JAR`). APK _declarations_ still work through apktool.                      |
| ADB device workflows                         | No device or emulator in the container.                                                                                                      |
| Browser capture                              | Needs a Chromium build (`--with-browser`) and a reachable page; heavy for 2 vCPU.                                                            |
| Frida / LLDB / native UI runtime observation | No target process to attach to, no macOS accessibility APIs, ptrace blocked in the default sandbox profile.                                  |
| Firmware extraction                          | Pinned to Binwalk **3.1.x** (Debian ships 2.4.3) or Unblob **26.6.x**.                                                                       |
| `rea setup` client registration              | There is no client to configure; the skill is consumed as repository documentation and `doctor` reports `skill:identity` as missing.         |

## Resource discipline

| Knob                                   | Value                                | Why                                                    |
| -------------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| `NODE_OPTIONS`                         | `--max-old-space-size` ≈ 60 % of RAM | keeps builds inside the cgroup                         |
| `REA_GHIDRA_STARTUP_TIMEOUT_MS`        | `600000`                             | a cold import that takes minutes is normal, not a hang |
| `REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS` | `180`                                | one function cannot own the turn                       |
| `REA_MCP_MAX_RESPONSE_BYTES`           | `10485760`                           | REA's floor; retained Evidence keeps the full record   |

- **One heavy job at a time.** Two concurrent Ghidra imports exhaust RAM.
- **Do not reinstall casually.** Prefer `npm run build:cached`; `npm ci` needs the
  swapfile.
- **Price output before reading it.** `--token-count`, `--token-limit`,
  `--filter-output`, `--format md|toon`; keep JSON for records a later call reads.
- **Reuse the warm session.** `--snapshot <dir>` and retained Evidence avoid paying
  for the same import twice; `evidence-export` persists a bundle into the workspace.

## Troubleshooting ladder

| Observed result                                                                        | Meaning                                                    | Action                                                                                                                    |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `bootstrap.sh --check` says `NEEDS PROVISIONING`                                       | container reset or first use                               | `bash scripts/sandbox/bootstrap.sh`                                                                                       |
| `unsupported_version … JDK 25 or newer`                                                | `JAVA_HOME` points at JDK 11/21                            | re-run with `--with-native`; confirm `JAVA_HOME=/usr/lib/jvm/java-25-openjdk-amd64`                                       |
| `GHIDRA_INSTALL_DIR is not set`                                                        | deep-analysis profile not installed, or exports not loaded | `--with-native`, then `set -a; . ./.rea-sandbox.env; set +a`                                                              |
| `provider_unavailable` with all candidates rejected                                    | nothing configured for that route                          | read `details.rejections[]` (`code`, `reason`, `remediation`); do not retry unchanged                                     |
| `Selected Python lacks pwntools 4.15.0`                                                | `REA_PWNTOOLS_PYTHON` points at another interpreter        | point it at `/opt/rea-engines/py/bin/python3`                                                                             |
| `npm ci` exits with `Killed`                                                           | OOM killer                                                 | confirm swap (`free -m`), retry with `--maxsockets=6`                                                                     |
| `Killed` during `npm run build`                                                        | heap above available RAM                                   | `NODE_OPTIONS=--max-old-space-size=1024` and rebuild                                                                      |
| `rea doctor` reports `hopper`, `ida-registration`, `jadx`, `kuna-installation` missing | expected                                                   | optional/caller-supplied integrations; not a broken install                                                               |
| `Unsupported wasm-validate version banner`                                             | WABT pin mismatch                                          | install WABT 1.0.42 or leave WASM unadvertised                                                                            |
| `oxlint` aborts (`oxc_allocator … fixed_size.rs`)                                      | bundled lint binary is incompatible with this container    | the slim profile ships no lint gate; use `npm run typecheck`, `npm run verify:module-boundaries`, `npm run sandbox:check` |

## Contributing back

Fixes that are genuinely general — readiness messages, engine detection,
memory-aware defaults, Evidence provenance — belong upstream at
[morluto/rea](https://github.com/morluto/rea) under
[CONTRIBUTING.md](../CONTRIBUTING.md). Restore the development tree first
(`bash scripts/sandbox/slim-repo.sh --restore`) or clone upstream, so the upstream
gates can run. Keep sandbox-specific changes in `scripts/sandbox/`,
`docs/sandbox-environment.md`, `CREDITS.md` and the environment sections of
`AGENTS.md` and `.agents/skills/`, so upstream diffs stay reviewable.
