# Repository Guidelines

## Sandbox environment profile

REA is created and maintained by [morluto](https://github.com/morluto) and the
REA contributors at [morluto/rea](https://github.com/morluto/rea) under the MIT
license. This fork adds a headless-sandbox profile on top of upstream: a
provisioner, a capability verifier, an environment guide and the agent guidance
in this section. The analysis engines, tool catalog, Evidence model and workflow
skill are upstream work; see [CREDITS.md](CREDITS.md) before changing either
side. Upstream rules in the sections below still apply unless this section says
otherwise for this host.

**Host facts.** Assume a disposable Linux x86_64 container: ~2 vCPU, ~2 GiB RAM,
no swap until provisioned, no display and no GUI applications, outbound HTTPS
available, passwordless `sudo` available, and only the workspace directory
persisting between sessions. Engines, JDK, and Python packages are therefore
installed by script each session, never assumed.

**Bootstrap and readiness.** Source the provisioned exports before any REA call
(`set -a; . ./.rea-sandbox.env; set +a`). Re-provision with
`bash scripts/sandbox/provision-sandbox.sh` (idempotent) rather than repairing
paths by hand. Verify with `node scripts/sandbox/verify-sandbox.mjs`, which
re-derives the capability matrix on the host and writes
`docs/verification/sandbox-capability-report.json`. Read
[docs/sandbox-environment.md](docs/sandbox-environment.md) before changing either
script.

`rea doctor` reporting `hopper`, `ida-registration`, `jadx`, `kuna-installation`
or `skill:identity` as missing is expected here: those providers are macOS-only,
commercial, caller-supplied or client-owned, and there is no MCP client to
register against. Do not treat that output as a broken installation, and do not
run `rea setup` to "fix" it.

**Route by what the host can do.** Prefer the routes that need no engine:
JavaScript/Electron and web-bundle analysis, deterministic format parsers,
archive inventory and APK declarations. Escalate to Ghidra (provisioned, with
JDK 25) only for questions those parsers cannot answer. Do not start a workflow
that needs a device (ADB), a browser build, Frida/LLDB attachment, Hopper, IDA,
JEB, Kuna, a caller-supplied JADX JAR, Binwalk 3.1.x, Unblob 26.6.x or WABT
1.0.42 unless the caller supplies it. Report the limit with the tool's own
`code` and `remediation` instead of attempting a call that must refuse.

**Budget the host.** Run one native deep-analysis job at a time; concurrent
Ghidra imports exhaust the container. Treat `REA_GHIDRA_STARTUP_TIMEOUT_MS`
(600 s here) as patience rather than a hang, keep per-call decompile deadlines
bounded, and never retry an identical call after a timeout or
`provider_unavailable` — change the input, resolve the reported configuration, or
stop and state the limit. `npm ci` re-materializes the whole tree and needs the
provisioned swapfile; prefer `npm run build:cached`, and cap the build heap with
`NODE_OPTIONS=--max-old-space-size` when memory is tight.

**Budget the context.** This host answers through the CLI, so use its output
controls before pasting results into a conversation: `--token-count`,
`--token-limit`, `--token-offset`, `--filter-output`, `--format md|toon` for
reading and `--json` for records that later calls consume. Keep summary-first
Evidence, page retained `parent_evidence_id` views with
`inspect-analysis-view`, and use `evidence-export` when a result must outlive
the session.

**Keep sandbox changes separable.** Sandbox-specific work belongs in
`scripts/sandbox/`, `docs/sandbox-environment.md`, `CREDITS.md`, the leading
section of this file and the environment sections of
`.agents/skills/reverse-engineer-anything/` (including
`references/sandbox-environment.md`). Never commit `.rea-sandbox.env`,
provisioned engine directories, or machine-specific paths, so upstream diffs stay
reviewable and the sandbox layer stays droppable. Fixes that are genuinely
general — readiness messages, engine detection, memory-aware defaults, evidence
provenance — should be offered upstream at
[morluto/rea](https://github.com/morluto/rea) under
[CONTRIBUTING.md](CONTRIBUTING.md).

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

## Development

Use [.nvmrc](.nvmrc) and `package.json#packageManager` for the pinned toolchain. Cursor Cloud may place older Node.js first on `PATH`; environment setup installs the pinned toolchain under `/usr/local/bin`. Prefix `PATH="/usr/local/bin:$PATH"` before `node` and `npm`.

- `npm ci`: install locked dependencies.
- `npm run build:cached`: build the runtime and packaged skill.
- `npm run test:local -- PATH...`: source tests without building.
- `npm run test:focused -- PATH...`: exact tests with their required artifacts.
- `npm run check:fast`: cached typecheck/lint and the pre-push check.
- `npm run docs:check`: validate generated documentation.
- `npm run sandbox:provision`: provision this headless container (Node, JDK 25,
  Ghidra, pwntools, host tools) and build; idempotent.
- `npm run sandbox:verify`: re-derive the capability matrix for this host and
  write the report to `docs/verification/sandbox-capability-report.json`.
- `npm run sandbox:check`: the verification subset that works here (typecheck,
  module boundaries, documentation facts, capability report).

`npm run lint` does not work in this container: the bundled `oxlint` aborts with
an `oxc_allocator` panic on any input, including a single file. That is a
toolchain incompatibility, not a finding. Do not "fix" it by editing lint
configuration or source; rely on `npm run typecheck`, `npm run
verify:module-boundaries`, targeted `vitest run`, and the documentation checks,
and note in the PR that lint was unavailable rather than claiming it passed.

Use relevant checks for the change. The complete local gate, `npm run check:pr`, is optional for broad changes or CI diagnosis. See [CONTRIBUTING.md](CONTRIBUTING.md) for development, generated-file ownership, and release conventions.

When changing installers or setup recovery, follow
[Checking installers and publisher downloads](docs/testing.md#checking-installers-and-publisher-downloads).

Coordinate expensive checks across agents. If a test unexpectedly consumes heavy CPU, stop its owned process family and profile a bounded representative case before retrying. Inspect production work, fixture generation, subprocesses, and repeated setup; preserve regression coverage when optimizing. Follow the [test resource guidance](docs/testing.md#developer-commands).

`docs/public/product-catalog.json`, `docs/verification/managed-conformance-*.json`, and `skills/` are ignored outputs. Edit source contracts and `.agents/skills/reverse-engineer-anything/`, then regenerate as needed. `.cache/mcp-tool-catalog.json` is test metadata; runtime builds and source checking do not consume it. Never commit binaries, provider project documents, credentials, `dist/`, `node_modules/`, or local planning artifacts.

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
