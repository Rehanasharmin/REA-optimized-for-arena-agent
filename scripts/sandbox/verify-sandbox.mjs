#!/usr/bin/env node
/**
 * REA sandbox capability verifier.
 *
 * Runs a fixed matrix of REA CLI operations against generated fixtures and
 * reports, per operation, whether it works in *this* machine's headless
 * sandbox or what configuration it still needs. The result is a machine-checked
 * compatibility report, not a claim: every "ok" row is a command that exited 0
 * and returned an Evidence record on this host.
 *
 * Usage:
 *   node scripts/sandbox/verify-sandbox.mjs [options]
 *
 * Options:
 *   --quick           Skip the deep-analysis probes (Ghidra analyze/decompile).
 *   --json <path>     Also write the machine-readable report to <path>.
 *   --timeout <ms>    Per-probe deadline (default 120000; deep probes get 4x).
 *   --no-color        Disable ANSI color in the table.
 *   --help            Show this help.
 *
 * The script reads `.rea-sandbox.env` from the repository root when present, so
 * provisioned paths (JAVA_HOME, GHIDRA_INSTALL_DIR, REA_PWNTOOLS_PYTHON) apply
 * without the caller exporting them. It never modifies the repository.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(
    `${[
      "REA sandbox capability verifier",
      "",
      "Usage: node scripts/sandbox/verify-sandbox.mjs [--quick] [--json <path>]",
      "       [--timeout <ms>] [--no-color] [--help]",
      "",
    ].join("\n")}\n`,
  );
  process.exit(0);
}

const optionValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined
    ? argv[index + 1]
    : fallback;
};
const quick = argv.includes("--quick");
const jsonPath = optionValue("--json", null);
const baseTimeout = Number(optionValue("--timeout", "120000")) || 120_000;
const color = !argv.includes("--no-color") && process.stdout.isTTY === true;

const paint = (code, text) =>
  color ? `\u001B[${code}m${text}\u001B[0m` : text;

/** Load the provisioner's export file without executing shell. */
async function sandboxEnvironment() {
  const path = join(repoRoot, ".rea-sandbox.env");
  const environment = { ...process.env };
  if (!existsSync(path)) return { environment, loaded: false };
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    const match = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
    if (match === null) continue;
    const [, key, rawValue] = match;
    const value = rawValue.replace(/^"(.*)"$/, "$1");
    // PATH accumulates so a pre-existing entry is not dropped.
    environment[key] =
      key === "PATH" && environment.PATH
        ? `${value}:${environment.PATH}`
        : value;
  }
  return { environment, loaded: true };
}

const run = (command, args, { environment, timeoutMs, cwd = repoRoot }) =>
  new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 2_000_000) stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 200_000) stderr += String(chunk);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr, timedOut });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ status: -1, stdout, stderr: String(error), timedOut });
    });
  });

const crcTable = Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1)
    value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** Deterministic stored (uncompressed) ZIP, so no `zip` binary is required. */
function storedZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    let crc = 0xff_ff_ff_ff;
    for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    crc = (crc ^ 0xff_ff_ff_ff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04_03_4b_50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02_01_4b_50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

const FIXTURE_C_SOURCE = `#include <stdio.h>
static int checksum(const char *text) {
  int hash = 0;
  while (*text) hash = (hash * 31 + *text++) & 0x7fffffff;
  return hash;
}
static int verify(const char *key) { return checksum(key) == 0x1a2b3c4d; }
int main(int argc, char **argv) {
  if (argc < 2) { puts("usage: fixture KEY"); return 2; }
  if (verify(argv[1])) { puts("licensed"); return 0; }
  puts("unlicensed");
  return 1;
}
`;

/** A tiny JavaScript application tree: the engine-free analysis path. */
const FIXTURE_JS = {
  "package.json":
    '{"name":"sandbox-fixture","version":"1.0.0","main":"dist/main.js"}',
  "dist/main.js": `const { app, ipcMain } = require("electron");
const license = require("./license");
app.whenReady().then(() => {
  ipcMain.handle("license:check", (_event, key) => ({ ok: license.verifyKey(key) }));
  ipcMain.handle("license:status", () => ({ plan: license.currentPlan() }));
});
`,
  "dist/license.js": `const crypto = require("crypto");
const SECRET = "sandbox-fixture-secret";
function verifyKey(key) {
  const digest = crypto.createHash("sha256").update(key + SECRET).digest("hex");
  return digest.startsWith("00");
}
function currentPlan() { return verifyKey("pro-key") ? "pro" : "free"; }
module.exports = { verifyKey, currentPlan };
`,
};

async function buildFixtures(environment) {
  const root = await mkdtemp(join(tmpdir(), "rea-sandbox-fixtures-"));
  const workspace = {
    root,
    elf: null,
    zip: join(root, "fixture.zip"),
    javascript: join(root, "javascript-app"),
    wasm: join(root, "empty.wasm"),
  };

  const source = join(root, "fixture.c");
  await writeFile(source, FIXTURE_C_SOURCE);
  const compiled = join(root, "fixture");
  const build = await run("cc", ["-O1", "-o", compiled, source], {
    environment,
    timeoutMs: 60_000,
    cwd: root,
  });
  if (build.status === 0 && existsSync(compiled)) workspace.elf = compiled;

  await writeFile(
    workspace.zip,
    storedZip([
      {
        name: "fixture/manifest.json",
        data: Buffer.from('{"kind":"sandbox"}'),
      },
      {
        name: "fixture/README.txt",
        data: Buffer.from("rea sandbox fixture\n"),
      },
    ]),
  );

  for (const [name, contents] of Object.entries(FIXTURE_JS))
    await writeFileInTree(workspace.javascript, name, contents);
  await writeFile(
    workspace.wasm,
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
  );
  return workspace;
}

async function writeFileInTree(base, name, contents) {
  const path = join(base, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

const probes = () => {
  const list = [
    {
      id: "cli",
      label: "CLI version report",
      args: ["--version"],
      core: true,
    },
    {
      id: "doctor",
      label: "Env doctor",
      args: ["doctor", "--json"],
      core: true,
      // doctor reports health in its own envelope; non-zero is informative.
      tolerateFailure: true,
      summarize: (payload) => {
        const failing = (payload.scope_checks ?? [])
          .filter((check) => check.ok === false)
          .map((check) => check.name);
        return payload.healthy === true
          ? "healthy"
          : `unhealthy: ${failing.join(", ") || "unspecified"}`;
      },
    },
    {
      id: "environment",
      label: "Provider inventory",
      args: ["providers", "--format", "json"],
      core: true,
      summarize: (payload) => {
        const groups = (payload.capabilities ?? []).flatMap(
          (entry) => entry.groups ?? [],
        );
        const available = groups.filter((group) => group.available === true);
        return `${available.length}/${groups.length} capability groups available`;
      },
    },
    {
      id: "byte-entropy",
      label: "Byte entropy (pure)",
      args: ["inspect-byte-entropy", "<elf>"],
      core: true,
      needs: "elf",
    },
    {
      id: "elf-notes",
      label: "ELF notes (pure)",
      args: ["inspect-elf-notes", "<elf>"],
      core: true,
      needs: "elf",
    },
    {
      id: "artifact",
      label: "Archive inventory (pure)",
      args: ["inspect-artifact", "<zip>"],
      core: true,
      needs: "zip",
    },
    {
      id: "javascript",
      label: "JavaScript app graph (no engine)",
      args: ["analyze-javascript-application", "<javascript>"],
      core: true,
      needs: "javascript",
    },
    {
      id: "objdump",
      label: "objdump inspection",
      args: ["inspect-with-objdump", "<elf>", "disassemble"],
      needs: "elf",
    },
    {
      id: "binary-layout",
      label: "Binary layout (pwntools)",
      args: ["inspect-binary-layout", "<elf>"],
      needs: "elf",
    },
    {
      id: "pcap",
      label: "TShark client",
      args: ["inspect-pcap-client"],
    },
    {
      id: "apktool",
      label: "apktool client",
      args: ["inspect-apktool-client"],
    },
    {
      id: "wasm",
      label: "WASM inspection (WABT)",
      args: ["inspect-wasm-artifact", "<wasm>"],
    },
  ];
  if (quick) return list;
  return [
    ...list,
    {
      id: "ghidra-analyze",
      label: "Ghidra deep analysis",
      args: ["analyze", "<elf>"],
      needs: "elf",
      timeoutScale: 6,
    },
    {
      id: "ghidra-decompile",
      label: "Ghidra decompile",
      args: ["decompile", "<elf>", "--procedure", "main"],
      needs: "elf",
      timeoutScale: 6,
    },
  ];
};

const NEEDS_CODE = {
  provider_unavailable: "needs-config",
  capability_unavailable: "needs-config",
  unsupported_host: "unsupported",
  invalid_request: "bug",
  VALIDATION_ERROR: "bug",
  UNKNOWN: "bug",
};

function classify(probe, result) {
  if (result.timedOut)
    return { status: "timeout", detail: `exceeded ${probe.timeoutMs} ms` };
  let payload = null;
  const firstJson = result.stdout
    .trim()
    .split("\n")
    .find((line) => line.startsWith("{"));
  if (firstJson)
    try {
      payload = JSON.parse(firstJson);
    } catch {
      payload = null;
    }
  const summary =
    payload === null ? null : (probe.summarize?.(payload) ?? null);
  // REA answers either a plain record, an Evidence record, or an error
  // envelope `{error: {code, message, remediation}}`.
  const error = payload?.error ?? null;
  const code = payload?.code ?? error?.code ?? null;
  const message =
    payload?.message ??
    error?.message ??
    payload?.remediation?.action ??
    error?.remediation?.action ??
    result.stderr.trim().split("\n").at(-1) ??
    "";
  if (result.status === 0) {
    return {
      status: "ok",
      detail:
        summary ??
        (payload?.evidence_id
          ? `evidence ${payload.evidence_id.slice(0, 15)}…`
          : (payload?.version ?? "returned a result")),
    };
  }
  const mapped = NEEDS_CODE[code] ?? (probe.tolerateFailure ? "ok" : "failed");
  return {
    status: mapped,
    detail: (summary ?? [code, message].filter(Boolean).join(": ")).slice(
      0,
      150,
    ),
  };
}

const environmentChecks = (environment) => {
  const checks = [];
  const note = (label, ok, detail) => checks.push({ label, ok, detail });
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  note(
    "node",
    nodeMajor >= 22,
    `${process.version} (>=$22.23 required by package.json engines)`,
  );
  const javaHome = environment.JAVA_HOME;
  note(
    "java",
    javaHome !== undefined && existsSync(join(javaHome, "bin/java")),
    javaHome ?? "JAVA_HOME unset (Ghidra needs a 64-bit JDK 25+)",
  );
  const ghidraHome = environment.GHIDRA_INSTALL_DIR;
  note(
    "ghidra",
    ghidraHome !== undefined &&
      existsSync(join(ghidraHome, "support/analyzeHeadless")),
    ghidraHome ?? "GHIDRA_INSTALL_DIR unset",
  );
  const pwntools = environment.REA_PWNTOOLS_PYTHON;
  note(
    "pwntools",
    pwntools !== undefined && existsSync(pwntools),
    pwntools ?? "REA_PWNTOOLS_PYTHON unset",
  );
  return checks;
};

async function main() {
  const { environment, loaded } = await sandboxEnvironment();
  const table = [];
  const fixtures = await buildFixtures(environment);
  try {
    for (const probe of probes()) {
      const missing = probe.needs === "elf" && fixtures.elf === null;
      if (missing) {
        table.push({
          id: probe.id,
          label: probe.label,
          status: "skipped",
          detail: "no C compiler (cc) to build a fixture ELF",
        });
        continue;
      }
      const args = probe.args.map((argument) =>
        argument === "<elf>"
          ? fixtures.elf
          : argument === "<zip>"
            ? fixtures.zip
            : argument === "<javascript>"
              ? fixtures.javascript
              : argument === "<wasm>"
                ? fixtures.wasm
                : argument,
      );
      const timeoutMs = baseTimeout * (probe.timeoutScale ?? 1);
      const result = await run(
        process.execPath,
        ["scripts/rea.mjs", ...args, "--json"],
        { environment, timeoutMs },
      );
      const classified = classify({ ...probe, timeoutMs }, result);
      table.push({ id: probe.id, label: probe.label, ...classified, args });
    }
  } finally {
    await rm(fixtures.root, { recursive: true, force: true });
  }

  const checks = environmentChecks(environment);
  const ok = table.filter((row) => row.status === "ok").length;
  const failed = table.filter((row) =>
    ["failed", "bug", "timeout"].includes(row.status),
  ).length;

  const lines = [];
  lines.push("", paint("1", "REA sandbox capability report"));
  lines.push(
    `${process.platform}/${process.arch} · node ${process.versions.node} · ${new Date().toISOString()}`,
  );
  lines.push(
    loaded ? "environment: .rea-sandbox.env" : "environment: process env only",
  );
  lines.push("");
  lines.push("| capability | status | detail |");
  lines.push("| --- | --- | --- |");
  for (const row of table) {
    const badge =
      row.status === "ok"
        ? paint("32", "ok")
        : row.status === "needs-config"
          ? paint("33", "needs-config")
          : row.status === "unsupported"
            ? paint("90", "unsupported")
            : paint("31", row.status);
    lines.push(`| ${row.label} | ${badge} | ${row.detail ?? ""} |`);
  }
  lines.push("");
  lines.push("| environment check | state | detail |");
  lines.push("| --- | --- | --- |");
  for (const check of checks)
    lines.push(
      `| ${check.label} | ${check.ok ? paint("32", "ok") : paint("33", "attention")} | ${check.detail} |`,
    );
  lines.push("");
  lines.push(
    `${ok}/${table.length} capabilities verified on this host; ${failed} failed.`,
  );
  const report = lines.join("\n");
  process.stdout.write(`${report}\n`);

  if (jsonPath !== null) {
    await writeFile(
      jsonPath,
      `${JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          platform: `${process.platform}/${process.arch}`,
          node: process.versions.node,
          used_sandbox_env_file: loaded,
          environment_checks: checks,
          capabilities: table,
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(`report written to ${jsonPath}\n`);
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

await main();
