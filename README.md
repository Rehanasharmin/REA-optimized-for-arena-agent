# REA Sandbox Edition

<div align="center">

**A disposable, headless-agent-friendly fork of [REA](https://github.com/morluto/rea) — reverse engineering across binaries, applications, and runtime behavior.**

[![Upstream](https://img.shields.io/badge/upstream-morluto%2Frea-5c4ee5?style=flat-square)](https://github.com/morluto/rea)
[![License](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22.x%20%7C%2024.x%20%7C%2026.12.1%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#requirements)

<code>node scripts/sandbox.mjs install</code>

</div>

---

## Credit

**REA is created and maintained by [morluto](https://github.com/morluto) and the REA contributors at [morluto/rea](https://github.com/morluto/rea).**

The analysis engines, CLI/MCP tool catalog, Evidence model, workflow skill, documentation, and the original README are their work — see [CREDITS.md](CREDITS.md). This fork only adapts REA to run inside a disposable, headless agent sandbox, and trims the checkout to what an agent actually needs (~3.2k files instead of ~7.2k).

If you are not specifically working in that sandbox, **use upstream instead**: [morluto/rea](https://github.com/morluto/rea) · [rea.tools](https://rea.tools/).

## What this fork changes

- **One command for the whole lifecycle.** [`scripts/sandbox.mjs`](scripts/sandbox.mjs) replaces `bootstrap.sh`, `verify-sandbox.mjs` and `slim-repo.sh` with `status`, `install`, `verify`, `run`, `batch`, `slim`, `env` and `report`. One file, no dependencies, no shell glue.
- **Sandbox-first provisioning.** `install` fetches Node.js, JDK 25, Apktool, `jadx-headless-mcp` and `pwntools` into `/opt/rea-engines` (with allowed-registry fallbacks over npm, PyPI and GitHub when OS mirrors are blocked), writes a gitignored `.rea-sandbox.env`, and verifies what actually works on the host.
- **No export step.** `scripts/rea.mjs` and `sandbox run` load `.rea-sandbox.env` automatically, so `set -a; . ./.rea-sandbox.env; set +a` is optional.
- **Faster feedback loops.** `status` is a single dependency-free process that answers in well under 100 ms with no npm and no network; `verify` probes concurrently instead of one CLI start per row; a warm re-provision skips `npm ci` while `node_modules` still matches the lockfile; `batch` runs a sweep of analyses in one call.
- **CLI-driven, no MCP client required.** The host drives REA through `node scripts/rea.mjs`, not a registered MCP server.
- **Trimmed checkout.** Development material removed for the file budget can be restored with `node scripts/sandbox.mjs slim --restore`.
- **Honest limits.** Hopper, IDA, JEB, ADB, browsers, Frida, firmware, and WASM are not available in the default sandbox; the verified capability matrix lives in [docs/sandbox-environment.md](docs/sandbox-environment.md).

Nothing in the analysis engines or Evidence model has been forked or reimplemented — it is all upstream code.

## Sandbox quick start

```bash
node scripts/sandbox.mjs status                    # is this container ready? (no npm, no network)
node scripts/sandbox.mjs install                   # provision + build (~40 s warm, 42 s cold)
node scripts/sandbox.mjs install --profile native  # add JDK 25 + Ghidra decompilation
node scripts/sandbox.mjs verify --quick            # prove what works here

node scripts/sandbox.mjs run analyze-javascript-application /abs/path/to/app --json
node scripts/sandbox.mjs run analyze /abs/path/to/binary --json    # --profile native
```

Everything above is idempotent, writes only `/opt/rea-engines` plus the gitignored `.rea-sandbox.env`, and needs no MCP client. The environment file is picked up automatically — sourcing it is no longer required.

### Sandbox commands

| Command       | What it does                                                                                                                                                            | Typical cost         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `status`      | Per-check readiness report: node, deps, runtime, JDK, Ghidra, JADX, apktool, pwntools, host tools, RAM, disk. `--json`, `--strict`. Exit 1 when provisioning is needed. | < 100 ms             |
| `install`     | Provision what is missing and build. `--profile agent\|native\|minimal\|gdb\|browser\|full`, `--plan`, `--force`. Skips itself when the profile is already satisfied.   | 2 s warm, ~42 s cold |
| `verify`      | Re-derive the capability matrix against generated fixtures. `--quick`, `--all`, `--filter`, `--concurrency`, `--json <path>`.                                           | seconds              |
| `run`         | Run the REA CLI with the sandbox environment loaded and the exit status forwarded. `--timings`, `--no-env`.                                                             | one CLI call         |
| `batch`       | Run many REA commands in one call; JSONL per-command status, timing and Evidence ids. Native commands stay serial.                                                      | one sweep            |
| `slim`        | Trim the checkout to the agent file budget, or `--restore` it from git. `--dry-run`, `--json`.                                                                          | seconds              |
| `env`         | Print, `export`, `--write` the derived sandbox environment (memory budgets, engine paths).                                                                              | < 100 ms             |
| `report`      | Write the combined status + capability report to `docs/sandbox-capability-report.json`.                                                                                 | seconds              |
| `completions` | Print bash/zsh completion for the CLI.                                                                                                                                  | instant              |

`npm run sandbox:status`, `sandbox:install`, `sandbox:verify`, `sandbox:slim`, `sandbox:run`, `sandbox:batch`, `sandbox:env` and `sandbox:report` wrap the same commands (`sandbox:bootstrap` and `sandbox:provision` are kept as aliases). The old script files are gone; their replacements are listed in the [migration table](docs/sandbox-environment.md#replacing-the-old-scripts).

Agents should read [AGENTS.md](AGENTS.md) first — it is the runbook — then [docs/sandbox-environment.md](docs/sandbox-environment.md) for the verified capability matrix, honest limits, and the troubleshooting ladder.

## Requirements

- **Node.js** 22.x (≥22.23.4), 24.x (≥24.22.1), or 26.12.1+, plus npm.
- On Linux, Ghidra, JADX, firmware tool launches, and static JavaScript/Electron analysis require a procps-compatible `ps` on `PATH` for process-ownership checks. Recovery steps are in [docs/installation.md](docs/installation.md) under "Linux owned-process prerequisite".

## What works in this sandbox

The default sandbox covers static inspection and a subset of the upstream catalog. Confirmed capabilities include:

- **Android APKs & React Native / Hermes** — APK inventory & application-graph projection (`project-android-application-graph`), v1/v2/v3 signing inspection (`inspect-apk-signature`), pure-TS Hermes bytecode bundle inspection (`inspect-hermes-bytecode`), Apktool resource/manifest decoding (`decode-android-resources`), and JADX DEX/manifest/JNI/xref decompilation (`inspect-android-package`, `search-android-classes`, `inspect-android-class`, `inspect-android-method`, `inspect-android-jni-bindings`, `trace-android-references`).
- **JavaScript / Electron** — modules, imports, source maps, routes, IPC and native add-on relationships (static, no native engine).
- **.NET assemblies** — metadata, CIL instructions, declared native dependencies, build comparisons (static).
- **Native binaries** — pseudocode, assembly, strings, symbols, calls and references via Ghidra headless, **only with `--with-native`**.
- **Go, Rust, ELF notes, PE imports, PE certificates, kernel modules, Erlang BEAM, SQLite (`node:sqlite`), model artifacts, Flutter/AOT, IL2CPP metadata, Godot PCK, Apple IPS** — built-in static inspection, no external engine.
- **Desktop installations and packages** — bounded directory/header inspection, digests, plists, Apple bundle anatomy.

Not available in the default sandbox: Hopper, IDA, JEB, ADB devices, browser observation, Frida, firmware, WASM, packet captures (when `tshark` cannot be installed), and recorded logic signals. See [docs/sandbox-environment.md](docs/sandbox-environment.md) for the authoritative matrix and how to add each one.

For the full upstream feature list — Android, iOS, firmware, WASM, network captures, RL environments, and everything else — see the [upstream README](https://github.com/morluto/rea#what-you-can-analyze).

## Upstream references

- **Repository:** [morluto/rea](https://github.com/morluto/rea)
- **Website and guides:** [rea.tools](https://rea.tools/) · [Guides](https://rea.tools/guides/) · [Showcases](https://rea.tools/showcase/)
- **npm package:** [`rea-agents`](https://www.npmjs.com/package/rea-agents) — used by both upstream and this fork
- **Documentation:** [installation](docs/installation.md) · [CLI and Evidence](docs/cli.md) · [MCP contracts](docs/mcp-contracts.md) · [tool catalog](docs/mcp-contracts.md#generated-catalog) · [roadmap](docs/roadmap.md)

## Documentation in this fork

- [AGENTS.md](AGENTS.md) — the sandbox runbook
- [docs/sandbox-environment.md](docs/sandbox-environment.md) — the sandbox CLI, capability matrix and honest limits
- [CREDITS.md](CREDITS.md) — upstream attribution
- [docs/installation.md](docs/installation.md) — upstream setup reference
- [docs/cli.md](docs/cli.md) — upstream CLI reference

Run `node scripts/sandbox.mjs help` (or `help <command>`) for the full option list.

Report vulnerabilities through [SECURITY.md](SECURITY.md).

## License and third-party notices

[MIT](LICENSE). REA-authored code is MIT-licensed; third-party material retains its own licenses and copyright notices — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the dependency inventory, preserved license texts, and external-tool terms.

**You must legally obtain and be authorized to use commercial tools**, including IDA Pro / Hex-Rays decompilers, Hopper, and JEB, under their applicable licenses. REA grants no tool license, key, or activation entitlement. Trials and demos remain subject to vendor terms, including user, feature, automation, and output-sharing restrictions. Cracked copies, stolen keys, unauthorized key sharing, and bypassing license restrictions are not authorized. This guidance does not amend MIT or third-party licenses.

See [DISCLAIMER.md](DISCLAIMER.md) for responsible-use guidance. REA is for lawful research, education, interoperability, software preservation, and analysis of software you own or are authorized to examine.

## Contributing

Improvements to the sandbox adaptation belong in this fork's issue tracker and pull requests. Everything else — engines, tool catalog, Evidence model, guides — belongs upstream: [morluto/rea issues](https://github.com/morluto/rea/issues) · [morluto/rea pull requests](https://github.com/morluto/rea/pulls). See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and checks.

---
