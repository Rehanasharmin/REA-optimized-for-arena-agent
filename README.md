# REA Sandbox Edition

<div align="center">

**A disposable, headless-agent-friendly fork of [REA](https://github.com/morluto/rea) — reverse engineering across binaries, applications, and runtime behavior.**

[![Upstream](https://img.shields.io/badge/upstream-morluto%2Frea-5c4ee5?style=flat-square)](https://github.com/morluto/rea)
[![License](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22.x%20%7C%2024.x%20%7C%2026.12.1%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#requirements)

<code>bash scripts/sandbox/bootstrap.sh</code>

</div>

---

## Credit

**REA is created and maintained by [morluto](https://github.com/morluto) and the REA contributors at [morluto/rea](https://github.com/morluto/rea).**

The analysis engines, CLI/MCP tool catalog, Evidence model, workflow skill, documentation, and the original README are their work — see [CREDITS.md](CREDITS.md). This fork only adapts REA to run inside a disposable, headless agent sandbox, and trims the checkout to what an agent actually needs (~3.2k files instead of ~7.2k).

If you are not specifically working in that sandbox, **use upstream instead**: [morluto/rea](https://github.com/morluto/rea) · [rea.tools](https://rea.tools/).

## What this fork changes

- **Sandbox-first entrypoint.** A bootstrap script provisions engines into `/opt/rea-engines`, writes a gitignored `.rea-sandbox.env`, and verifies what actually works on the host.
- **CLI-driven, no MCP client required.** The host drives REA through `node scripts/rea.mjs`, not a registered MCP server.
- **Trimmed checkout.** Development material removed for the file budget can be restored with `bash scripts/sandbox/slim-repo.sh --restore`.
- **Honest limits.** Hopper, IDA, JEB, JADX, ADB, browsers, Frida, firmware, and WASM are not available in the default sandbox; the verified capability matrix lives in [docs/sandbox-environment.md](docs/sandbox-environment.md).

Nothing in the analysis engines or Evidence model has been forked or reimplemented — it is all upstream code.

## Sandbox quick start

```bash
bash scripts/sandbox/bootstrap.sh --check         # is this container ready?
bash scripts/sandbox/bootstrap.sh                 # provision + build (~40 s warm, 42 s cold)
bash scripts/sandbox/bootstrap.sh --with-native   # add JDK 25 + Ghidra decompilation

set -a; . ./.rea-sandbox.env; set +a              # engine paths and host budgets

node scripts/sandbox/verify-sandbox.mjs --quick            # prove what works here
node scripts/rea.mjs analyze-javascript-application /abs/path/to/app --json
node scripts/rea.mjs analyze /abs/path/to/binary --json    # needs --with-native
```

Everything above is idempotent, writes only `/opt/rea-engines` plus the gitignored `.rea-sandbox.env`, and needs no MCP client.

Agents should read [AGENTS.md](AGENTS.md) first — it is the runbook — then [docs/sandbox-environment.md](docs/sandbox-environment.md) for the verified capability matrix, honest limits, and the troubleshooting ladder.

## Requirements

- **Node.js** 22.x (≥22.23.4), 24.x (≥24.22.1), or 26.12.1+, plus npm.
- On Linux, Ghidra, JADX, firmware tool launches, and static JavaScript/Electron analysis require a procps-compatible `ps` on `PATH` for process-ownership checks. Recovery steps are in [docs/installation.md](docs/installation.md) under "Linux owned-process prerequisite".

## What works in this sandbox

The default sandbox covers static inspection and a subset of the upstream catalog. Confirmed capabilities include:

- **JavaScript / Electron** — modules, imports, source maps, routes, IPC and native add-on relationships (static, no native engine).
- **.NET assemblies** — metadata, CIL instructions, declared native dependencies, build comparisons (static).
- **Native binaries** — pseudocode, assembly, strings, symbols, calls and references via Ghidra headless, **only with `--with-native`**.
- **Go, Rust, ELF notes, PE imports, PE certificates, kernel modules, Erlang BEAM, model artifacts, IL2CPP metadata, Godot PCK, Apple IPS** — built-in static inspection, no external engine.
- **Desktop installations and packages** — bounded directory/header inspection, digests, plists, Apple bundle anatomy.

Not available in the default sandbox: Hopper, IDA, JEB, JADX (Android APK), ADB devices, browser observation, Frida, firmware, WASM, packet captures, and recorded logic signals. See [docs/sandbox-environment.md](docs/sandbox-environment.md) for the authoritative matrix and how to add each one.

For the full upstream feature list — Android, iOS, firmware, WASM, network captures, RL environments, and everything else — see the [upstream README](https://github.com/morluto/rea#what-you-can-analyze).

## Upstream references

- **Repository:** [morluto/rea](https://github.com/morluto/rea)
- **Website and guides:** [rea.tools](https://rea.tools/) · [Guides](https://rea.tools/guides/) · [Showcases](https://rea.tools/showcase/)
- **npm package:** [`rea-agents`](https://www.npmjs.com/package/rea-agents) — used by both upstream and this fork
- **Documentation:** [installation](docs/installation.md) · [CLI and Evidence](docs/cli.md) · [MCP contracts](docs/mcp-contracts.md) · [tool catalog](docs/mcp-contracts.md#generated-catalog) · [roadmap](docs/roadmap.md)

## Documentation in this fork

- [AGENTS.md](AGENTS.md) — the sandbox runbook
- [docs/sandbox-environment.md](docs/sandbox-environment.md) — capability matrix and honest limits
- [CREDITS.md](CREDITS.md) — upstream attribution
- [docs/installation.md](docs/installation.md) — upstream setup reference
- [docs/cli.md](docs/cli.md) — upstream CLI reference

Report vulnerabilities through [SECURITY.md](SECURITY.md).

## License and third-party notices

[MIT](LICENSE). REA-authored code is MIT-licensed; third-party material retains its own licenses and copyright notices — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the dependency inventory, preserved license texts, and external-tool terms.

**You must legally obtain and be authorized to use commercial tools**, including IDA Pro / Hex-Rays decompilers, Hopper, and JEB, under their applicable licenses. REA grants no tool license, key, or activation entitlement. Trials and demos remain subject to vendor terms, including user, feature, automation, and output-sharing restrictions. Cracked copies, stolen keys, unauthorized key sharing, and bypassing license restrictions are not authorized. This guidance does not amend MIT or third-party licenses.

See [DISCLAIMER.md](DISCLAIMER.md) for responsible-use guidance. REA is for lawful research, education, interoperability, software preservation, and analysis of software you own or are authorized to examine.

## Contributing

Improvements to the sandbox adaptation belong in this fork's issue tracker and pull requests. Everything else — engines, tool catalog, Evidence model, guides — belongs upstream: [morluto/rea issues](https://github.com/morluto/rea/issues) · [morluto/rea pull requests](https://github.com/morluto/rea/pulls). See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and checks.

---
