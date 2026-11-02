# Repository Guidelines

## Start here: lean, sandbox-ready REA

REA is created and maintained by [morluto](https://github.com/morluto) and the
REA contributors at [morluto/rea](https://github.com/morluto/rea) under the MIT
license. This checkout is their work in a **slim, headless-sandbox profile**:
~3.2k files instead of ~7.2k, so it fits an agent workspace budget (10k files).
Development-only material (test suites, the documentation website, CI, release
and lint tooling, translated READMEs) was removed by
`scripts/sandbox/slim-repo.sh`. Nothing that runs during an investigation was
removed: `src/`, `scripts/`, `bridge/`, the `docs/*.md` guides, the workflow
skill and the sandbox tooling are all present. Restore anything with
`bash scripts/sandbox/slim-repo.sh --restore`, or clone
[morluto/rea](https://github.com/morluto/rea) for full fidelity. Provenance and
third-party terms: [CREDITS.md](CREDITS.md).

### 1. Orient in one call

```bash
bash scripts/sandbox/bootstrap.sh --check        # add --json for machine reading
```

Cheap and side-effect free (no npm, no network). It prints `READY` or
`NEEDS PROVISIONING` plus exactly which rows are missing. Run this first instead
of guessing whether the checkout is built.

### 2. Provision what is missing

```bash
bash scripts/sandbox/bootstrap.sh                 # ~42 s: Node, swap, host tools, pwntools venv, build
bash scripts/sandbox/bootstrap.sh --with-native   # adds JDK 25 + Ghidra (~570 MB) for decompilation
```

Both are idempotent and write only `/opt/rea-engines` and the gitignored
`.rea-sandbox.env`. Then load the exports in every shell:

```bash
set -a; . ./.rea-sandbox.env; set +a
```

Containers reset between sessions: if `bootstrap.sh --check` fails, re-run
`bootstrap.sh` before anything else.

### 3. Verify instead of assuming

```bash
node scripts/sandbox/verify-sandbox.mjs --quick        # seconds
node scripts/sandbox/verify-sandbox.mjs --json docs/sandbox-capability-report.json
```

Each `ok` row is a command that exited 0 with an Evidence record on _this_ host.
`needs-config` and `unsupported` rows are limits to report, not failures to
retry.

### 4. Investigate

| Target                                                                                                 | Start with                                                | Requires                             |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------ |
| Electron/asar, extracted JavaScript, web bundle                                                        | `analyze-javascript-application`                          | nothing                              |
| Archives, packages, unknown files                                                                      | `inspect-artifact`, `extract-artifact`                    | nothing                              |
| ELF/PE/Mach-O identity, notes, imports, strings, entropy, managed .NET, SQLite, PCAP, APK declarations | the matching `inspect-*` command                          | nothing (apktool/tshark provisioned) |
| ELF layout, symbols, relocations, mitigations                                                          | `inspect-binary-layout`                                   | pwntools venv (default profile)      |
| Decompilation, call graphs, function dossiers                                                          | `analyze` → `function` / `decompile` / `xrefs` / `search` | `--with-native`                      |

Prefer the cheapest route that answers the question, and escalate only for a
question the cheap route cannot answer. Everything is available through the CLI
(`node scripts/rea.mjs <command> <absolute-path> --json`); this host has no MCP
client to register against, so skip the client-recovery ladders in
`references/connection-and-recovery.md`.

### Host facts and budgets

Disposable Linux x86_64 container: ~2 vCPU, ~2 GiB RAM, no display, no GUI
applications, outbound HTTPS, passwordless `sudo`, only the workspace persists.
Engines, JDK and Python packages are installed by script, never assumed.

- Run **one** native deep-analysis job at a time; concurrent Ghidra imports
  exhaust the container.
- `REA_GHIDRA_STARTUP_TIMEOUT_MS=600000` is patience, not a hang: a small ELF
  imports in ~15 s, a large one takes minutes. Keep per-call decompile deadlines
  bounded (`.rea-sandbox.env` sets 180 s).
- Never repeat an identical call after a timeout or `provider_unavailable`.
  Read `details.rejections[]` (`code`, `reason`, `remediation`), fix that, or
  state the limit.
- Cap memory explicitly: `NODE_OPTIONS=--max-old-space-size=<MiB>`. `npm ci`
  needs the provisioned swapfile; prefer `npm run build:cached` in a warm tree.
- Price output before reading it: `--token-count`, `--token-limit`,
  `--token-offset`, `--filter-output`, `--format md|toon` for reading, `--json`
  for records a later call consumes. Keep summary-first Evidence, page retained
  `parent_evidence_id` views with `inspect-analysis-view`, and use
  `evidence-export` when a result must outlive the session.
- `rea doctor` reporting `hopper`, `ida-registration`, `jadx`, `kuna-installation`
  or `skill:identity` as missing is expected here — macOS-only, commercial,
  caller-supplied or client-owned integrations. Do not run `rea setup` to fix it.

### Do not attempt without caller-supplied software

Hopper (macOS-only), IDA, JEB, Kuna, JADX-based Android code, ADB devices,
browser scenarios (Chromium is not installed), Frida/LLDB attachment, native UI
observation, firmware tooling (Binwalk 3.1.x / Unblob 26.6.x) and WASM inspection
(WABT 1.0.42). Report the tool's own `code` and `remediation` rather than
attempting a call that must refuse; [docs/sandbox-environment.md](docs/sandbox-environment.md)
explains each limit.

### Keep sandbox work separable

Sandbox-specific changes belong in `scripts/sandbox/`, `docs/sandbox-environment.md`,
`docs/sandbox-capability-report.json`, `CREDITS.md`, this leading section, and the
environment sections of `.agents/skills/reverse-engineer-anything/`. Never commit
`.rea-sandbox.env`, provisioned engine directories or machine-specific paths.
Fixes that are generally useful — readiness messages, engine detection,
memory-aware defaults, evidence provenance — belong upstream at
[morluto/rea](https://github.com/morluto/rea) under [CONTRIBUTING.md](CONTRIBUTING.md).

## Product and Authority

REA is a local-only reverse-engineering tool with shared CLI/MCP workflows. Distinguish observations, derivations, inferences, and unknowns; preserve Evidence provenance and session semantics through both adapters. Provider support and setup live in [README.md](README.md#choosing-a-deep-analysis-provider) and its linked guides.

Follow the [contribution scope and fail-closed integration rule](CONTRIBUTING.md#contribution-scope). Do not integrate capabilities while material scope, authority, side-effect, or required verification questions remain unresolved. For new providers or capabilities involving target execution, injection, mutation, or protection recovery, seek the required maintainer scope decision before substantial implementation for integration. Welcome early proposals, small exploratory prototypes, and draft PRs that help resolve questions; they do not authorize integration.

Ghidra uses ephemeral databases without modifying executable bytes or controlling a GUI; Windows Ghidra P0 has no mutation authority. IDA analysis is read-only; never save or close an attached GUI database.

Configuration changes must be additive and idempotent, with backups. Installers must not install or upgrade unrelated software, including Homebrew, Node.js, npm, Java, or Ghidra. Ghidra and IDA are bring-your-own. `rea setup` must show its planned changes and require approval before writing files or installing Hopper.

Preserve caller-selected inputs and local evidence, including output, URLs, paths, digests, and metadata. Redact transport authentication credentials and explicitly marked sensitive values; do not infer secrecy from names or text patterns. Do not persist the ambient environment merely because a child inherits it.

## Architecture and Cleanup

Dependencies flow inward: domain semantics and contracts, provider adapters, shared application workflows, then CLI/MCP adapters. Keep engine protocols and provider-specific code out of domain/application layers. See [docs/architecture.mermaid](docs/architecture.mermaid) when changing composition.

Give each interpretation and resource a clear owner. Consumers must use that owner's parsed facts rather than reinterpret raw source. Preserve identity, omission, uncertainty, and source evidence across boundaries. Retain ownership of resources whose cleanup failed. Reuse `src/process/` supervision and identity primitives; a PID and executable path alone do not establish ownership after exit or reuse.

Keep proof of ownership separate from validity, editability, and readiness. Malformed owned data may still be safely removable. Unresolved identity or applicability must remain unknown rather than be treated as absent, foreign, or aligned.

For lifecycle changes, follow [ownership and completion invariants](docs/tool-design.md#own-the-lifecycle) and select the applicable [lifecycle regressions](docs/testing.md#lifecycle-regressions). Include late handshakes, cancellation during final cleanup, mixed child outcomes, and cleanup retry where those stages exist; active-execution cancellation alone does not cover finalization.

Before adding complexity for a speculative or vanishingly unlikely race or security edge case, explain the concrete failure mode, likelihood, and complexity cost to the user and get their buy-in. Do not silently expand scope for theoretical robustness.

Assess brittleness in touched code during implementation, debugging, review, and maintenance. Fix the producing representation or ownership rule before adding downstream repairs. Normalize once at the owning boundary using format-aware parsers. Remove superseded representations, aliases, wrappers, and redundant tests after verifying affected consumers. Introduce abstractions only when they remove observed complexity.

When fixing a bug, inspect the producing boundary and affected consumers for duplicated interpretation or unclear ownership. Complete any directly related refactor in the same change and remove superseded code. Passing regression tests alone does not establish that the brittleness is resolved. If related cleanup remains, explain what remains and why.

After confirming a bug, search sibling adapters, consumers and similar workflows
for the same failure. Verify suspected matches, record working comparisons, and
group findings by root cause instead of filing duplicate reports.

When addressing a review thread, inspect the producing boundary and affected consumers for brittleness. Complete directly related refactoring in the same change. Before resolving the thread, explain the root cause, structural fix, validation, and any remaining cleanup.

Parse unknown boundary values and model expected failures with the tagged error algebra and `Result`. Preserve partial facts and meaningful failure reasons. Keep identity and lookup values separate from display formatting; preserve source values and explicit unknowns when normalization loses information. Absolute paths, file URLs, and HTTP paths have different semantics.

Validate advertised JSON Schemas after SDK conversion against their declared dialect and actual clients. Bind handlers to named contracts with exact types; catalog ordering must never select an operation or schema.

## Performance

Design analysis workflows and agent interfaces for efficiency from the first
implementation. Correctness, useful answers, Evidence provenance, caller choices,
compatibility and safe resource bounds remain required.

Optimize in this order:

1. Agent tokens and context. Return the smallest sufficient answer with
   necessary provenance, coverage and limitations. Use task selection,
   summaries, paging and retained Evidence where supported; honor requested
   detail and keep complete Evidence accessible. Count the whole task,
   including schemas, extra calls and retries.
2. Analysis time. Reuse validated results and shared work. Cache keys must
   cover result-affecting inputs; define invalidation and lifetime. Validate
   freshness before reporting cached live state as current.
3. CPU and memory. Avoid unnecessary work and copies; bound concurrency,
   retained state and serialization growth.

Reserve performance measurements for changes that target performance or have a
concrete regression concern. Routine cleanup uses correctness checks; changes
to helper calls, imports, or representations alone do not require synthetic
benchmarks. When measurement is warranted, measure representative completed
tasks and compare equivalent workflows before and after where available. Report
token usage, elapsed time, CPU time and peak process-family memory. Separate cold
and warm runs, label estimates, and state unmeasured costs. Fewer bytes alone
do not establish fewer tokens or faster analysis.

## Development in this slim tree

Use [.nvmrc](.nvmrc) and `package.json#packageManager` for the pinned toolchain,
and keep `/usr/local/bin` first on `PATH` (`export PATH="/usr/local/bin:$PATH"`).

- `npm ci` — install locked dependencies (keep optional dependencies; `--omit=optional`
  breaks the compile step because `@tsrs/linux-x64-gnu` is optional).
- `npm run build:cached` — build the runtime and packaged skill (Turbo-cached).
- `npm run typecheck` — TypeScript gate; works here and is the primary signal.
- `npm run verify:module-boundaries` — architecture guard over `src/`.
- `npm run format` / `npm run format:check` — `oxfmt`; keep the tree formatted.
- `npm run sandbox:check` — typecheck + boundaries + capability report in one pass.
- `npm run sandbox:bootstrap` — provision and verify from a bare container.
- `npm run sandbox:slim` — re-apply (or `--restore`) the slim profile.

**What this profile removed.** `scripts/sandbox/slim-repo.sh` deleted the test
suites (`tests/`, `src/**/*.test.ts`), the documentation website, `.github` CI,
the translated READMEs, the changelog, and the lint/mutation/release tooling, to
fit an agent workspace file budget. Consequences:

- `npm test`, `npm run check:pr`, `npm run lint`, `npm run docs:check` and the
  husky pre-commit hook are gone with their inputs. Do not present them as run
  or as passing; state that the profile cannot run them.
- `oxlint` additionally aborts in this container on any input (an
  `oxc_allocator` panic), so even a restored tree cannot lint here.
- To work on upstream-facing changes, restore first
  (`bash scripts/sandbox/slim-repo.sh --restore`) or clone
  [morluto/rea](https://github.com/morluto/rea), then use [CONTRIBUTING.md](CONTRIBUTING.md)
  and the gates it describes.

`docs/public/product-catalog.json`, `docs/verification/managed-conformance-*.json`
and `skills/` are generated outputs; edit source contracts and
`.agents/skills/reverse-engineer-anything/`, then regenerate. Never commit
binaries, provider project documents, credentials, `dist/`, `node_modules/`,
`.rea-sandbox.env` or local planning artifacts.

## Tool and Test Changes

For tool design, follow [docs/tool-design.md](docs/tool-design.md): start from the analyst question, reuse existing contracts, preserve caller choices, and return useful evidence inline. Limits must follow real format, protocol, authority, or resource constraints. Account for representation expansion before allocation; derive completeness from examined coverage.

For user- or agent-facing tool problems, prioritize fixing the owning behavior,
contract, and actionable result or recovery at the point of use. Document the
result in product docs when explanation is needed. Add skill guidance only for
workflow judgment or context that the tool cannot reasonably convey; do not use
a skill as the primary repair for a discoverability or contract defect.

For test changes or provider claims, use [docs/testing.md](docs/testing.md). Select applicable [boundary regressions](docs/testing.md#boundary-regressions) for parser, inventory, snapshot, and projection fixes. Prefer real public CLI/MCP workflows, then production-boundary integration, then producer goldens. Keep module tests for distinct semantics stronger workflows cannot reliably reproduce. Preserve malformed-input, cancellation, cleanup, permission, capacity, and target-identity coverage when pruning. Report unverified coverage explicitly; simulated providers do not establish real-provider behavior.

Use Conventional Commit subjects and PR titles. Mark breaking changes with `!` or a `BREAKING CHANGE:` footer. Describe behavior changes, relevant validation, and real-provider verification scope.

## Issue Reports

Follow [issue reporting guidance](CONTRIBUTING.md#reporting-issues) and the matching
issue form. Keep reports concise and cite the smallest useful evidence.
Distinguish observed results, source-derived reasoning, hypotheses, and proposed
checks. Never claim runtime reproduction or measurements you did not perform.
Use `NOT_ENOUGH_INFO` with an explanation for missing narrative answers or evidence.
Incomplete reports, source-only findings, and early feature or design ideas are
welcome when their limitations are explicit; a completed diagnosis or fix is not
required to open an issue.

## Pull Request Readiness

Follow [human ownership and readiness](CONTRIBUTING.md#pull-request-ownership-and-readiness)
when preparing a PR. AI-assisted contributions are welcome; a human must review
and own the final diff, check the validation evidence and its limitations, and
explicitly declare the PR ready for initial maintainer review.

Keep the PR body concise and current, with the concrete problem, observable
outcome, approach, and evidence. Report only checks that actually ran as executed;
distinguish source-derived conclusions, proposed checks, and unavailable coverage.
Address actionable automated review findings and explain disagreements.

Leave the template's **Author readiness** declarations unchecked for the human
owner to complete. Never attest to human review on their behalf. Draft status
is optional; preserve the PR's current draft status unless the user asks to change
it. Later pushes do not invalidate the readiness declaration or require another
human sign-off. Keep the PR body and affected validation current as work changes.
The readiness check validates
the filled declaration; CI and automated review results do not establish that
human review occurred, maintainer scope approval, or merge permission.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
