# REA in a headless agent sandbox

This page describes the **sandbox edition** of REA: the same tool, adapted to run
inside a disposable, headless Linux container that an AI agent drives through a
shell instead of an MCP-registered desktop client.

It records what actually works in such a container (verified by a script, not by
assumption), what stays unavailable and why, and the resource discipline that
keeps a 2 vCPU / 2 GiB host from tipping over.

> REA is created and maintained by [morluto](https://github.com/morluto) and the
> REA contributors at [morluto/rea](https://github.com/morluto/rea). This page
> and the `scripts/sandbox/` helpers are additions of this fork; the analysis
> engine, tool catalog, Evidence model and workflow skill are upstream work.
> See [CREDITS.md](../CREDITS.md).

## Environment profile

The sandbox class this edition targets:

| Property       | Value                                                                       |
| -------------- | --------------------------------------------------------------------------- |
| OS / arch      | Debian 13 (trixie), Linux x86_64                                            |
| CPU / RAM      | 2 vCPU, ~2 GiB RAM, no swap by default                                      |
| Display        | none (no X11, no Wayland, no GUI applications)                              |
| Package access | `apt-get`, `pip`, `npm` available; passwordless `sudo`                      |
| Client         | no MCP client registration; the agent runs the CLI through its shell tool   |
| Persistence    | only the workspace directory persists; `/opt` and installed packages do not |
| Network        | outbound HTTPS available                                                    |

Those constraints, not REA itself, drive every decision below. In particular:
analysis engines are not preinstalled, there is no GUI application to attach to,
and anything written outside the workspace must be re-created per session — which
is why provisioning is a script rather than a one-time install.

## Provision in one command

```bash
bash scripts/sandbox/provision-sandbox.sh
set -a; . ./.rea-sandbox.env; set +a
node scripts/sandbox/verify-sandbox.mjs
```

The provisioner is idempotent and changes nothing outside `/opt/rea-engines` and
the gitignored `.rea-sandbox.env`:

1. **Node.js** — installs the version pinned in `.nvmrc` into `/usr/local` when
   the image's Node is older (this image ships Node 20; `package.json#engines`
   requires `^22.23.4 || ^24.22.1 || >=26.12.1`).
2. **Swap** — adds a 2 GiB swapfile when the host has under 4 GiB RAM and no
   swap. Without it, `npm ci` is OOM-killed mid-install and looks like a broken
   dependency tree.
3. **JDK 25** — REA's Ghidra readiness check requires a 64-bit **full JDK 25 or
   newer**. Debian's default `java` is JDK 11 and fails that check; the
   provisioner installs `openjdk-25-jdk-headless` and repoints the `java`
   alternative.
4. **Ghidra** — downloads the current public Ghidra release (12.2 at the time of
   writing) into `/opt/rea-engines` and exports `GHIDRA_INSTALL_DIR`.
5. **pwntools stack** — creates `/opt/rea-engines/py` with the exact versions REA
   admits (`pwntools 4.15.0`, `pyelftools 0.33`, `Unicorn 2.1.2`) and exports
   `REA_PWNTOOLS_PYTHON`. REA never installs Python packages itself, and the
   system interpreter is PEP 668-managed, so a dedicated venv is the honest way
   to satisfy the pin.
6. **Host tools** — `binutils`, `file`, `zip`/`unzip`, `procps`, `sqlite3`,
   `tshark`, `apktool`.
7. **Build** — `npm ci` with a bounded heap and socket count, then
   `npm run build:cached`.

Useful flags: `--minimal` (Node + build only, ~1 minute), `--no-native` (skip
Ghidra/JDK/pwntools), `--no-apt`, `--no-build`, `--check` (plan only), `--root`
(engine directory), `--with-gdb`, `--with-browser`.

`npm run sandbox:check` runs the verification subset that works on this host:
typecheck, module boundaries, documentation facts and the sandbox capability
report.

## What works here (verified)

`node scripts/sandbox/verify-sandbox.mjs` re-derives this table on any host and
writes `docs/verification/sandbox-capability-report.json`. The run below is from
the reference sandbox (`13/14` capabilities verified, 0 failed):

| Capability                                                                                                                                   | Status       | Path / requirement                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| CLI, `--version`, `doctor`, `providers`                                                                                                      | works        | no engine needed                                                                                                        |
| Deterministic parsers (`inspect-byte-entropy`, `inspect-elf-notes`, `inspect-macho`, `inspect-plist`, `inspect-python-pyc`, …)               | works        | pure TypeScript parsers                                                                                                 |
| Archive/package inventory (`inspect-artifact`, `extract-artifact`, `compare-artifacts`)                                                      | works        | pure TypeScript                                                                                                         |
| JavaScript / Electron static analysis (`analyze-javascript-application`, `trace-javascript-semantics`, `compare-application-versions`)       | works        | **no engine required** — the fastest path in this environment                                                           |
| Ghidra deep analysis (`analyze`, `function`, `decompile`, `search`, `xrefs`, `decompile-all`)                                                | works        | Ghidra 12.2 + JDK 25, ~14 s cold import on a small ELF                                                                  |
| ELF layout, symbols, relocations, mitigations (`inspect-binary-layout`)                                                                      | works        | `REA_PWNTOOLS_PYTHON` venv                                                                                              |
| GNU objdump inspection (`inspect-with-objdump`, `list-objdump-architectures`)                                                                | works        | `binutils`                                                                                                              |
| Packet captures (`inspect-pcap-capture`, `inspect-packet-fields`)                                                                            | works        | `tshark` 4.4                                                                                                            |
| APK resources (`inspect-apktool-client`, `decode-android-resources`, `inspect-android-package` declarations)                                 | works        | `apktool` 2.7.0                                                                                                         |
| SQLite / firmware-adjacent static parsers (`inspect-sqlite-database`, `inspect-devicetree`, `inspect-erlang-beam`, `inspect-model-artifact`) | works        | Node ≥ 24.15 for SQLite                                                                                                 |
| Managed (.NET) static inspection (`inspect-managed-artifact`, `inspect-managed-members`)                                                     | works        | pure TypeScript                                                                                                         |
| WASM inspection (`inspect-wasm-artifact`, `compare-wasm-interfaces`)                                                                         | needs config | requires WABT **1.0.42**; Debian ships 1.0.36, so the provisioner deliberately does not export `REA_WABT_BIN_DIRECTORY` |

## What stays unavailable, and why

These are honest limits of the environment, not defects to work around:

| Capability                                                                    | Reason                                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hopper provider                                                               | macOS-only application. On Linux REA reports `executable_missing` for `/opt/hopper/bin/Hopper`; the CLI never pretends the provider exists.                                                     |
| IDA, JEB, Kuna providers                                                      | Commercial tools supplied by the caller (`REA_IDA_MCP_CONFIG`, `REA_JEB_MCP_URL`, `REA_KUNA_COMMAND`). REA grants no license or entitlement.                                                    |
| JADX-backed Android code (`inspect-android-method`, `search-android-classes`) | Requires a caller-supplied `jadx-headless-mcp` JAR via `REA_JADX_MCP_JAR`. REA does not download it. APK _declarations_ still work through apktool.                                             |
| ADB device workflows                                                          | No device and no emulator in the container.                                                                                                                                                     |
| Browser capture (`capture-browser-scenario`, `observe-web-execution`)         | Needs a Chromium build (`--with-browser`) **and** a reachable page; headless captures are possible but heavy for 2 vCPU.                                                                        |
| Frida / LLDB / native UI runtime observation                                  | No target process to attach to, no macOS AX APIs, and ptrace is unavailable in the sandbox's default seccomp profile.                                                                           |
| Firmware extraction (`inspect-firmware-regions`, `extract-firmware`)          | Pinned to Binwalk **3.1.x** (Debian ships 2.4.3) or Unblob **26.6.x**. Supply `REA_BINWALK_COMMAND` / `REA_UNBLOB_COMMAND` yourself when needed.                                                |
| `rea setup` client registration                                               | There is no agent client to configure. The workflow skill is consumed as repository documentation (`AGENTS.md`, `.agents/skills/`), and `doctor` correctly reports `skill:identity` as missing. |

## Resource discipline

The container is small, so the defaults in `.rea-sandbox.env` are deliberately
conservative:

| Knob                                   | Value                                | Why                                                                                                                 |
| -------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `NODE_OPTIONS`                         | `--max-old-space-size` ≈ 60 % of RAM | Keeps a TypeScript build inside the cgroup instead of the OOM killer.                                               |
| `REA_GHIDRA_STARTUP_TIMEOUT_MS`        | `600000`                             | A cold Ghidra import that takes 330 s here is normal on 2 vCPU; the deadline is a _patience_ budget, not a hang.    |
| `REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS` | `180`                                | Bounds one function so a single call cannot own the whole turn.                                                     |
| `REA_MCP_MAX_RESPONSE_BYTES`           | `10485760`                           | REA's floor; keeps oversized payloads out of the agent's context while retained Evidence keeps the complete record. |

Operational rules that matter more than any single knob:

- **One heavy job at a time.** Two concurrent Ghidra imports exhaust RAM. Run
  native analysis serially; parallelise cheap parsers only.
- **Never reinstall casually.** `npm ci` re-materialises the tree and needs the
  swapfile. Prefer `npm run build:cached`, which is cached by Turbo.
- **Summary first.** Use `--token-count`, `--token-limit`, `--filter-output`,
  and `--format toon|md` for agent-visible output; keep JSON for the record.
- **Reuse the session.** `--snapshot <dir>` and retained Evidence avoid paying
  for the same import twice. `close_binary` / `reset_investigation` are CLI
  concerns only through `evidence-export`; the one-shot CLI exits on its own.

## Troubleshooting ladder

| Observed result                                                                                 | Meaning                                                                                                                                                              | Action                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unsupported_version … JDK 25 or newer`                                                         | `JAVA_HOME` points at JDK 11/21                                                                                                                                      | Re-run the provisioner; confirm `JAVA_HOME=/usr/lib/jvm/java-25-openjdk-amd64`.                                                                                                                     |
| `GHIDRA_INSTALL_DIR is not set`                                                                 | Engine path missing                                                                                                                                                  | `set -a; . ./.rea-sandbox.env; set +a` in the same shell, or re-provision after the container was reset.                                                                                            |
| `provider_unavailable` with every candidate rejected                                            | Nothing is configured at all                                                                                                                                         | Read `details.rejections[]`; each entry carries `code`, `reason` and `remediation`. Do not retry the identical call.                                                                                |
| `Selected Python lacks pwntools 4.15.0`                                                         | `REA_PWNTOOLS_PYTHON` resolves to a different interpreter than the venv                                                                                              | Point it at `/opt/rea-engines/py/bin/python3`.                                                                                                                                                      |
| `npm ci` exits with `Killed`                                                                    | OOM killer                                                                                                                                                           | Confirm the swapfile is active (`free -m`), then retry with `--maxsockets=6`.                                                                                                                       |
| `Killed` during `npm run build`                                                                 | Heap above available RAM                                                                                                                                             | Lower `NODE_OPTIONS=--max-old-space-size=1024` and rebuild.                                                                                                                                         |
| `rea doctor` reports `unhealthy` with `hopper`, `ida-registration`, `jadx`, `kuna-installation` | Expected here                                                                                                                                                        | Those providers are optional and unavailable by design in this container; it is not a broken install.                                                                                               |
| `Unsupported wasm-validate version banner`                                                      | WABT pin mismatch                                                                                                                                                    | Install WABT 1.0.42 or leave WASM inspection unadvertised.                                                                                                                                          |
| `oxlint` exits with `Aborted` / `oxc_allocator … fixed_size.rs` panic                           | The bundled `oxlint` 1.87 aborts in this container on any input, even a single file with memory to spare — a toolchain/allocator incompatibility, not a lint finding | Use the working gate instead: `npm run typecheck`, `npm run verify:module-boundaries`, `vitest run <paths>`, the documentation checks and `npm run sandbox:verify`. Lint in CI or on a normal host. |
| `git commit` fails in the husky pre-commit hook (`oxlint --fix`)                                | The same allocator crash, reached through lint-staged                                                                                                                | Commit with `HUSKY=0 git commit …` and say in the message or PR that lint could not run here. `oxfmt` (formatting) does work and must stay clean.                                                   |

## Contributing back

Anything here that is genuinely general — a better readiness message, an engine
detection fix, a memory-aware default — belongs upstream at
[morluto/rea](https://github.com/morluto/rea) under
[CONTRIBUTING.md](../CONTRIBUTING.md). Keep sandbox-specific provisioning and
prompt adaptations in `scripts/sandbox/`, `docs/sandbox-environment.md`,
`CREDITS.md` and the environment sections of `AGENTS.md`, so upstream diffs stay
reviewable.
