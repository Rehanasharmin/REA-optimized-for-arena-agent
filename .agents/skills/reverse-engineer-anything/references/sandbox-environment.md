# REA in a headless shell sandbox

Read this when REA runs inside a disposable Linux container driven by a shell
tool: no MCP client, no GUI, no preinstalled engines, a ~2 GiB memory budget and a
workspace file limit. It is a runbook: orient, provision, verify, investigate.

## 0. Orient (every session, one call)

```bash
bash scripts/sandbox/bootstrap.sh --check --json
```

Cheap and side-effect free. `ready:false` means the container reset or was never
provisioned. `deep_analysis:false` only means no decompiler is installed;
engine-free analysis still works.

## 1. Provision what is missing

```bash
bash scripts/sandbox/bootstrap.sh                 # ~42 s: Node, swap, host tools, pwntools, build
bash scripts/sandbox/bootstrap.sh --with-native   # adds JDK 25 + Ghidra (minutes, ~570 MB)
```

Then load engine paths and host budgets in every shell:

```bash
set -a; . ./.rea-sandbox.env; set +a
```

Skip the client-registration and `rea setup` recovery ladders in
[connection and recovery](connection-and-recovery.md): this host has no client to
register, and `doctor` reporting `hopper`, `ida-registration`, `jadx`,
`kuna-installation` or `skill:identity` as missing is expected.

## 2. Verify instead of assuming

```bash
node scripts/sandbox/verify-sandbox.mjs --quick   # seconds
```

Each `ok` row is a command that exited 0 with an Evidence record on this host.
Treat `needs-config` and `unsupported` rows as limits to report, not failures to
retry.

## 3. Route by what this host can do

| Target                                                                                                 | Start with                                                | Requires                                                    |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------- |
| Electron/asar, extracted JavaScript, web bundle                                                        | `analyze-javascript-application`                          | nothing — cheapest useful route                             |
| Archives, packages, unknown files                                                                      | `inspect-artifact`, `extract-artifact`                    | nothing                                                     |
| ELF/PE/Mach-O identity, notes, imports, strings, entropy, managed .NET, SQLite, PCAP, APK declarations | the matching `inspect-*` command                          | nothing                                                     |
| ELF layout, symbols, relocations, mitigations                                                          | `inspect-binary-layout`                                   | pwntools venv (default profile)                             |
| Decompilation, call graphs, function dossiers                                                          | `analyze` → `function` / `decompile` / `xrefs` / `search` | `--with-native`                                             |
| Firmware, WASM, Android code, ADB, browser, Frida, LLDB, Hopper, IDA, JEB, Kuna                        | **do not start**                                          | caller-supplied engine, device, browser build or macOS host |

Invoke through the CLI with absolute paths:
`node scripts/rea.mjs <command> /abs/path --json`. From outside a checkout use
`npx -y rea-agents@latest <command> /abs/path --json` instead.

## 4. Budget the host, not just the tokens

- One native deep-analysis job at a time; concurrent Ghidra imports exhaust 2 GiB.
- `REA_GHIDRA_STARTUP_TIMEOUT_MS=600000` is patience, not a hang. A small ELF
  imports in ~15 s; a large one takes minutes.
- Never repeat an identical call after a timeout or `provider_unavailable`. Read
  `details.rejections[]` and fix the reported configuration, or state the limit.
- Prefer `--snapshot <dir>` for several questions about the same binary.
- `--token-count` to price output, `--token-limit` / `--token-offset` to page it,
  `--filter-output` to keep only the fields the answer needs, `--format md|toon` to
  read and `--json` for records a later call consumes. Summary first; page retained
  `parent_evidence_id` views with `inspect-analysis-view`; `evidence-export` when a
  result must outlive the session.

## 5. Keep provenance honest

Separate **observation**, **inference** and **unknown**. Cite the Evidence ID, the
engine and version, and the coverage boundary. Static evidence never implies
runtime behaviour — in this container there is usually no way to run the target, so
say "not observed here". When a tool refuses, quote its `code` and `remediation`
instead of paraphrasing "analysis failed".

## 6. Recovery ladder

1. **`NEEDS PROVISIONING`** → `bash scripts/sandbox/bootstrap.sh` (never hand-edit
   engine paths).
2. **Workspace looks incomplete** (no tests, no website, no CI) → expected in the
   slim profile; `bash scripts/sandbox/slim-repo.sh --restore` restores it from git.
3. **`provider_unavailable`** → read `details.rejections[]`; fix or report.
4. **`unsupported_version`** → compare with the pinned requirement (JDK 25+,
   Ghidra 12.1+, WABT 1.0.42, Binwalk 3.1.x, Unblob 26.6.x) and stop if the host
   cannot meet it.
5. **`Killed` from npm/build** → memory, not logic: confirm swap, lower
   `NODE_OPTIONS=--max-old-space-size`, retry once.
6. **Truncated client output** → use the retained `parent_evidence_id` or
   `evidence-export`; do not re-run the producer.
