# REA in a headless shell sandbox

Read this when REA runs inside a disposable Linux container driven by a shell
tool: no MCP client, no GUI application, no preinstalled analysis engines, and a
small memory budget. It tells you what to expect, what to run first, and where to
stop.

A machine-checked copy of this matrix is produced by
`node scripts/sandbox/verify-sandbox.mjs`; the human-facing guide is
`docs/sandbox-environment.md` in the repository.

## Start from the provisioned environment

The sandbox exports its engine paths in `.rea-sandbox.env` at the repository
root. Source it once per shell before any REA call:

```bash
set -a; . ./.rea-sandbox.env; set +a
```

If that file is missing, or `GHIDRA_INSTALL_DIR` points at a directory that no
longer exists, the container was reset: run
`bash scripts/sandbox/provision-sandbox.sh` (idempotent, ~1 minute warm, several
minutes cold) instead of hand-repairing paths.

Check readiness **once per session**, not per task, and read the result rather
than treating `unhealthy` as a failure. In this container `doctor` reports
`hopper`, `ida-registration`, `jadx`, `kuna-installation` and `skill:identity`
as missing: those are optional, commercial, macOS-only or client-owned
integrations that cannot exist here. Their absence does not block any recommended
route below.

## Invoke the CLI, not a client

There is no MCP registration in this environment, so tools are reached through
the CLI. From a checkout:

```bash
node scripts/rea.mjs <command> <absolute-target-path> --json
```

When REA is only available as a package, use `npx -y rea-agents@latest` from a
trusted directory outside the target project. Always pass absolute target paths,
and keep the fixtures and outputs you intend to cite inside the workspace so
they survive the session.

## Route by what this host can actually do

| Target | Route here | Note |
| --- | --- | --- |
| Electron/asar, extracted JavaScript, web bundle | `analyze-javascript-application` | Engine-free and the cheapest useful answer; start here for anything JavaScript. |
| Native ELF/PE/Mach-O, managed .NET, archives | deterministic parser first (`inspect-artifact`, `inspect-elf-notes`, `inspect-pe-imports`, `inspect-with-objdump`, `inspect-managed-artifact`), then Ghidra | Pure parsers answer inventory questions without a 15 s import. |
| Decompilation, cross-references, function dossiers | `analyze` → `function` / `decompile` / `xrefs` / `search` | Requires `GHIDRA_INSTALL_DIR` and JDK 25 (both provisioned). |
| ELF layout, symbols, relocations, mitigations | `inspect-binary-layout` | Requires `REA_PWNTOOLS_PYTHON` (provisioned venv). |
| APK declarations and resources | `inspect-apktool-client`, `inspect-android-package`, `decode-android-resources` | apktool is provisioned. APK *code* needs a caller-supplied JADX JAR and stays unavailable. |
| Packet captures | `inspect-pcap-capture`, `inspect-web-network-capture` | tshark is provisioned. |
| Firmware, WASM, Android code, ADB, browsers, Frida, LLDB, Hopper, IDA, JEB, Kuna | **do not start** | Each needs a caller-supplied engine, a device, a browser build or a macOS host. Say so plainly instead of attempting a call that will return `capability_unavailable`. |

When several routes exist, prefer the one that costs one call and no engine, and
escalate only for a question the cheap route explicitly cannot answer.

## Budget the host, not just the tokens

- Run **one** native deep-analysis job at a time. Two concurrent Ghidra imports
  exhaust a 2 GiB container.
- Treat `REA_GHIDRA_STARTUP_TIMEOUT_MS` (600 s here) as patience, not as a hang.
  A cold import of a small binary takes ~15 s; a large one can take minutes.
- Keep `REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS` low (180 s) so one pathological
  function cannot own the turn.
- Never repeat an identical call after a timeout or `provider_unavailable`.
  Change the input, resolve the reported configuration, or report the limit.
- Prefer one warm process over many cold ones: pass `--snapshot <dir>` when you
  will ask several questions about the same binary.

## Budget the context

The CLI is built for this: use it before pasting large results.

- `--token-count` to price a call, `--token-limit` / `--token-offset` to page it.
- `--filter-output a,b.c` to keep only the fields the answer needs.
- `--format md` or `toon` for reading, `--json` when a later call consumes the
  record.
- Summary first, then retained Evidence: a summary returns `parent_evidence_id`
  that `inspect-analysis-view` can page. Request `detail: "complete"` only when
  the full dossier must travel inline.
- `evidence-export` writes the complete bundle to a workspace path when the
  answer needs to outlive the session, and gives you a file to cite.

## Keep provenance honest

Every conclusion separates **observation**, **inference** and **unknown**, and
cites the Evidence ID, the engine version, and the coverage boundary. Static
evidence never implies runtime behaviour — in this container there is usually no
way to run the target at all, so say "not observed here" instead of implying
you tested it. When a tool refuses (`capability_unavailable`,
`provider_unavailable`, `unsupported_version`), quote the reported code and
remediation rather than paraphrasing it into a vague "analysis failed".

## Recovery ladder

1. **Missing engine path** → source `.rea-sandbox.env`; if the path is gone,
   re-provision.
2. **`provider_unavailable`** → read `details.rejections[]`; each rejection names
   `code`, `reason`, `remediation`. Fix that, or state the limit.
3. **`unsupported_version`** → compare against the pinned requirement in the
   message (JDK 25+, Ghidra 12.1+, WABT 1.0.42, Binwalk 3.1.x, Unblob 26.6.x)
   and stop if the container cannot meet it.
4. **`Killed` from npm/build** → memory, not logic: confirm swap, lower
   `NODE_OPTIONS=--max-old-space-size`, retry once.
5. **Empty or truncated client output** → use the retained `parent_evidence_id`
   or `evidence-export`; do not re-run the producer.
