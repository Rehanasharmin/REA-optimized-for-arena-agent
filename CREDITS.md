# Credits and provenance

## Upstream project

**REA — Reverse Engineer Anything** is created and maintained by **morluto** and
the REA contributors.

- Repository: <https://github.com/morluto/rea>
- Website, guides and showcases: <https://rea.tools/>
- npm package: <https://www.npmjs.com/package/rea-agents>
- Community: <https://discord.gg/GkcryMnJDM>
- License: MIT — see [LICENSE](LICENSE), which is retained unmodified. Copyright
  (c) 2026 morluto.

Everything that makes REA useful is upstream work: the MCP server and CLI, the
tool catalog and its JSON Schemas, the Evidence and provenance model, the
provider adapters (Ghidra, Hopper, IDA, JEB, Kuna, Cutter, rizin, pwntools, …
), the deterministic format parsers, the setup and doctor commands, the workflow
skill, the test suites, the documentation and the website.

If you are looking for REA itself, use the upstream repository or the published
npm package. Do not treat this fork as an official distribution: it is not
published to npm, and its changes are not reviewed by the upstream maintainers.

## Third-party components

REA bundles or interoperates with third-party software under those projects' own
terms. The authoritative inventory, preserved license texts and external-tool
terms are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[licenses/](licenses); they are unchanged by this fork.

The sandbox provisioner downloads or installs additional software at the user's
request, without bundling it and without changing its license:

| Component                          | License / terms                  | Source                                             |
| ---------------------------------- | -------------------------------- | -------------------------------------------------- |
| Node.js                            | MIT-style (Node.js license)      | <https://nodejs.org/>                              |
| Eclipse Temurin / OpenJDK packages | GPL-2.0 with Classpath Exception | distribution packages                              |
| Ghidra                             | Apache-2.0                       | <https://github.com/NationalSecurityAgency/ghidra> |
| pwntools                           | MIT                              | <https://github.com/Gallopsled/pwntools>           |
| pyelftools                         | Public domain                    | <https://github.com/eliben/pyelftools>             |
| Unicorn Engine                     | GPL-2.0                          | <https://github.com/unicorn-engine/unicorn>        |
| TShark / Wireshark                 | GPL-2.0                          | <https://www.wireshark.org/>                       |
| apktool                            | Apache-2.0                       | <https://github.com/iBotPeaches/Apktool>           |
| WABT                               | Apache-2.0                       | <https://github.com/WebAssembly/wabt>              |

Commercial tools that REA can drive — IDA Pro / Hex-Rays, Hopper, JEB, Kuna —
remain governed by their vendors' terms and must be obtained and licensed by the
user. REA grants no license, key or entitlement for them.

## Changes in this fork

This fork is an environment adaptation, not a reimplementation.

| Path                                        | Purpose                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/sandbox/bootstrap.sh`              | One-command entry point: instant status (`--check`, `--json`), then provision only what is missing and verify.                                   |
| `scripts/sandbox/provision-sandbox.sh`      | Idempotent provisioning of Node.js, a swapfile, host tools and the pwntools venv (default profile), plus JDK 25 and Ghidra with `--with-native`. |
| `scripts/sandbox/verify-sandbox.mjs`        | Re-derives a capability matrix on the host and writes `docs/sandbox-capability-report.json`.                                                     |
| `scripts/sandbox/slim-repo.sh`              | Deterministically trims the checkout to an agent file budget (~7.2k to ~3.2k files) and restores it from git on demand.                          |
| `docs/sandbox-environment.md`               | Environment profile, verified matrix, limits, file budget, resource discipline, troubleshooting ladder.                                          |
| `AGENTS.md` (leading sections)              | The agent runbook: orient, provision, verify, route, budget. Upstream guidelines follow unchanged.                                               |
| `.agents/skills/reverse-engineer-anything/` | Sandbox section, a `references/sandbox-environment.md` runbook, and skill version bumps so installs refresh.                                     |
| `README.md`                                 | A sandbox quickstart and attribution block; the rest is upstream text with links to removed files repaired.                                      |
| `.rea-sandbox.env` (generated, gitignored)  | Machine-specific engine paths and budget knobs for the current container.                                                                        |

**Removed material.** `scripts/sandbox/slim-repo.sh` deletes what never runs during
an investigation, to stay inside an agent workspace file budget: the Vitest suites
and goldens (`tests/`, `src/**/*.test.ts`), the documentation website, the
translated READMEs, `.github` CI, the changelog, and the
lint/mutation/coverage/release tooling. Those are upstream _test and release_
artifacts, not upstream features — no analysis capability was removed. Run
`bash scripts/sandbox/slim-repo.sh --restore` (git-backed) or clone
[morluto/rea](https://github.com/morluto/rea) to get them back before contributing
upstream.

Upstream source and contracts are otherwise untouched, so diffing this tree against
the upstream commit shows exactly what the fork adds and what it trims. Fixes that
are generally useful should be offered upstream under
[CONTRIBUTING.md](CONTRIBUTING.md).

## Attribution in derived work

If you redistribute this fork, keep this file, [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and keep the upstream project
identified by name and link. The MIT license requires preserving the copyright
notice; courtesy requires keeping the attribution to the people who built the
thing.
