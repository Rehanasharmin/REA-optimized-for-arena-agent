#!/usr/bin/env node
/**
 * REA sandbox — one command for the whole headless-sandbox lifecycle.
 *
 * Replaces `bootstrap.sh`, `verify-sandbox.mjs` and `slim-repo.sh` with a single
 * entry point, and adds `run`, `batch`, `env` and `report` on top. No
 * dependencies: this file must work before `npm ci` has ever run.
 *
 *   node scripts/sandbox.mjs status            # readiness report, no side effects
 *   node scripts/sandbox.mjs install           # provision what is missing + build
 *   node scripts/sandbox.mjs verify --quick    # machine-checked capability matrix
 *   node scripts/sandbox.mjs run analyze /abs/path --json
 *   node scripts/sandbox.mjs batch --file tasks.txt
 *   node scripts/sandbox.mjs slim --dry-run
 *
 * Exit codes: 0 success/ready, 1 not ready or a required step failed,
 * 2 usage or preflight error.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { availableParallelism } from "node:os";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandboxEnvPath = join(repoRoot, ".rea-sandbox.env");
const provisionerPath = join(repoRoot, "scripts/sandbox/provision-sandbox.sh");
const cliPath = join(repoRoot, "scripts/rea.mjs");
const defaultSandboxRoot = "/opt/rea-engines";
const rawArgv = process.argv.slice(2);
const startedAt = performance.now();

/** Files the CLI refuses to run without. Mirrors `scripts/rea.mjs`. */
const RUNTIME_FILES = [
  "dist/cli-runtime/cli.js",
  "dist/cli-runtime/cliOutput.js",
  "dist/cli-runtime/cliResultOutput.js",
];

/** Commands that load Ghidra. Batch keeps these serial unless told otherwise. */
const NATIVE_COMMANDS = new Set([
  "analyze",
  "decompile",
  "function",
  "xrefs",
  "search",
  "inspect-native-pdb",
]);

const useColor =
  !rawArgv.includes("--no-color") &&
  process.env.NO_COLOR === undefined &&
  process.stdout.isTTY === true;
const paint = (code, text) =>
  useColor ? `\u001B[${code}m${text}\u001B[0m` : String(text);
const bold = (text) => paint("1", text);
const dim = (text) => paint("2", text);
const green = (text) => paint("32", text);
const yellow = (text) => paint("33", text);
const red = (text) => paint("31", text);
const cyan = (text) => paint("36", text);

// A closed pipe (`sandbox env | head`) is not a failure worth a stack trace.
process.stdout.on("error", (cause) => {
  if (cause?.code === "EPIPE") process.exit(0);
  throw cause;
});

class UsageError extends Error {}
class PreflightError extends Error {
  constructor(message, remediation) {
    super(message);
    this.remediation = remediation;
  }
}

// ---------------------------------------------------------------- arguments

const SHORT_FLAGS = { h: "help", j: "json", q: "quiet", v: "version" };
const COMMON_OPTIONS = {
  help: "boolean",
  json: "optional",
  "no-color": "boolean",
  quiet: "boolean",
  verbose: "boolean",
  timings: "boolean",
};

/**
 * Parse argv against an option spec. Types: `boolean`, `string`, `string[]`
 * (repeatable) and `optional` (true when no value follows). `--` ends parsing
 * so every remaining token belongs to the wrapped command.
 */
function parseOptions(argv, spec) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (argument.startsWith("--")) {
      const equals = argument.indexOf("=");
      const name =
        equals === -1 ? argument.slice(2) : argument.slice(2, equals);
      const inline = equals === -1 ? undefined : argument.slice(equals + 1);
      const type = spec[name];
      if (type === undefined) throw new UsageError(`unknown option: --${name}`);
      if (type === "boolean") {
        options[name] = inline === undefined ? true : inline !== "false";
      } else if (type === "optional") {
        if (inline !== undefined) options[name] = inline;
        else if (
          argv[index + 1] !== undefined &&
          !argv[index + 1].startsWith("-")
        ) {
          options[name] = argv[index + 1];
          index += 1;
        } else options[name] = true;
      } else if (type === "string[]") {
        const value = inline ?? argv[index + 1];
        if (value === undefined)
          throw new UsageError(`--${name} needs a value`);
        if (inline === undefined) index += 1;
        options[name] = [...(options[name] ?? []), value];
      } else {
        const value = inline ?? argv[index + 1];
        if (value === undefined)
          throw new UsageError(`--${name} needs a value`);
        if (inline === undefined) index += 1;
        options[name] = value;
      }
      continue;
    }
    if (argument.startsWith("-") && argument.length > 1) {
      const name = SHORT_FLAGS[argument.slice(1)];
      if (name === undefined || spec[name] === undefined)
        throw new UsageError(`unknown option: ${argument}`);
      options[name] = true;
      continue;
    }
    positionals.push(argument);
  }
  return { options, positionals };
}

const wantsJson = (options) => options.json !== undefined;
const writesJsonFile = (options) =>
  typeof options.json === "string" ? options.json : undefined;

async function writeJsonFile(path, value) {
  const target = resolve(process.cwd(), path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
  return target;
}

// -------------------------------------------------------------- environment

async function readSandboxEnvFile(path = sandboxEnvPath) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (cause?.code === "ENOENT") return { path, loaded: false, values: {} };
    throw cause;
  }
  const values = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (match === null) continue;
    values[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
  }
  return { path, loaded: true, values };
}

/**
 * Process environment with `.rea-sandbox.env` applied. Explicit shell values
 * win; PATH accumulates so a sourced file never drops existing entries.
 */
async function sandboxEnvironment() {
  const file = await readSandboxEnvFile();
  const environment = { ...process.env };
  for (const [key, value] of Object.entries(file.values)) {
    environment[key] =
      key === "PATH" && environment.PATH
        ? `${value}:${environment.PATH}`
        : value;
  }
  return {
    environment,
    loaded: file.loaded,
    path: file.path,
    values: file.values,
  };
}

async function isExecutable(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve bare command names against a PATH value without spawning a shell. */
async function resolveExecutables(names, pathValue) {
  const entries = (pathValue ?? "").split(":").filter((entry) => entry !== "");
  const found = {};
  await Promise.all(
    names.map(async (name) => {
      if (name.includes("/")) {
        if (await isExecutable(name)) found[name] = name;
        return;
      }
      for (const entry of entries) {
        const candidate = join(entry, name);
        if (await isExecutable(candidate)) {
          found[name] = candidate;
          return;
        }
      }
    }),
  );
  return found;
}

function parseVersion(text) {
  const parts = String(text)
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index])
      return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function satisfiesRange(version, range) {
  const trimmed = range.trim();
  if (trimmed === "" || trimmed === "*") return true;
  const match = /^(\^|~|>=|>|<=|<|=)?\s*(.+)$/.exec(trimmed);
  if (match === null) return true;
  const operator = match[1] ?? "=";
  const target = parseVersion(match[2]);
  const current = parseVersion(version);
  const comparison = compareVersions(current, target);
  switch (operator) {
    case "^":
      return current[0] === target[0] && comparison >= 0;
    case "~":
      return (
        current[0] === target[0] && current[1] === target[1] && comparison >= 0
      );
    case ">=":
      return comparison >= 0;
    case ">":
      return comparison > 0;
    case "<=":
      return comparison <= 0;
    case "<":
      return comparison < 0;
    default:
      return comparison === 0;
  }
}

const satisfiesEngines = (version, engines) =>
  engines.split("||").some((range) => satisfiesRange(version, range));

function heapBudget(totalMib) {
  const heap = Math.min(Math.max(Math.round(totalMib * 0.5), 512), 4096);
  const ts = Math.min(Math.max(Math.round(totalMib * 0.7), 1024), 3584);
  return { heap, ts };
}

async function hostBudget() {
  const budget = {
    cpus: availableParallelism(),
    memory_mib: 0,
    swap_mib: 0,
    disk_free_mib: null,
  };
  try {
    const info = await readFile("/proc/meminfo", "utf8");
    for (const line of info.split("\n")) {
      const match = /^(MemTotal|SwapTotal):\s+(\d+) kB/.exec(line);
      if (match === null) continue;
      const key = match[1] === "MemTotal" ? "memory_mib" : "swap_mib";
      budget[key] = Math.round(Number(match[2]) / 1024);
    }
  } catch {
    // Non-Linux or a restricted /proc: budget stays zero and is reported as such.
  }
  try {
    const stats = await statfs(repoRoot);
    budget.disk_free_mib = Math.floor((stats.bavail * stats.bsize) / 1_048_576);
  } catch {
    budget.disk_free_mib = null;
  }
  return budget;
}

async function sandboxRoot(environment) {
  return environment.REA_SANDBOX_ROOT ?? defaultSandboxRoot;
}

async function findJavaHome(environment) {
  const candidates = [];
  if (environment.JAVA_HOME) candidates.push(environment.JAVA_HOME);
  const root = await sandboxRoot(environment);
  candidates.push(join(root, "jdk"));
  for (const major of [25, 26, 27, 28]) {
    candidates.push(`/usr/lib/jvm/java-${major}-openjdk-amd64`);
  }
  for (const candidate of candidates) {
    if (await isExecutable(join(candidate, "bin/java"))) return candidate;
  }
  return undefined;
}

async function findGhidraHome(environment) {
  if (environment.GHIDRA_INSTALL_DIR) return environment.GHIDRA_INSTALL_DIR;
  const root = await sandboxRoot(environment);
  try {
    for (const entry of await readdir(root)) {
      if (!entry.startsWith("ghidra_")) continue;
      const home = join(root, entry);
      if (await isExecutable(join(home, "support/analyzeHeadless")))
        return home;
    }
  } catch {
    // Root does not exist yet.
  }
  return undefined;
}

/** Version-independent JADX discovery (the jar name carries its version). */
async function findJadxJar(environment) {
  if (environment.REA_JADX_MCP_JAR) return environment.REA_JADX_MCP_JAR;
  const root = await sandboxRoot(environment);
  const directory = join(root, "jadx");
  try {
    const entries = await readdir(directory);
    const jar = entries
      .filter(
        (entry) =>
          entry.startsWith("jadx-headless-mcp") && entry.endsWith(".jar"),
      )
      .sort()
      .at(-1);
    if (jar !== undefined) return join(directory, jar);
  } catch {
    // Not provisioned.
  }
  return undefined;
}

async function findPwntoolsPython(environment) {
  if (environment.REA_PWNTOOLS_PYTHON) return environment.REA_PWNTOOLS_PYTHON;
  const root = await sandboxRoot(environment);
  const python = join(root, "py", "bin", "python3");
  return (await isExecutable(python)) ? python : undefined;
}

async function packageMetadata() {
  const text = await readFile(join(repoRoot, "package.json"), "utf8");
  return JSON.parse(text);
}

async function pinnedNodeVersion() {
  try {
    return (await readFile(join(repoRoot, ".nvmrc"), "utf8")).trim();
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------- status

async function missingRuntimeFiles() {
  return RUNTIME_FILES.filter((file) => !existsSync(join(repoRoot, file)));
}

async function assertRuntimeBuilt() {
  const missing = await missingRuntimeFiles();
  if (missing.length === 0) return;
  throw new PreflightError(
    `REA's compiled runtime is missing (${missing[0]} not found).`,
    "Run `node scripts/sandbox.mjs install` (or `npm ci && npm run build:cached`).",
  );
}

const statusRow = (entry) => ({
  required: false,
  profile: "core",
  ...entry,
});

/**
 * One cheap, side-effect-free pass over everything the CLI needs. All probes
 * are filesystem lookups, so `status` stays sub-100 ms even on a cold host.
 */
async function gatherStatus() {
  const environmentInfo = await sandboxEnvironment();
  const environment = environmentInfo.environment;
  const root = await sandboxRoot(environment);
  // Everything below is a filesystem probe, run concurrently. `status` stays a
  // single process, so a cold host answers in well under 100 ms.
  const [
    host,
    pkg,
    pinned,
    resolvedJava,
    resolvedGhidra,
    resolvedJadx,
    resolvedPwntools,
    runtimeMissing,
    found,
  ] = await Promise.all([
    hostBudget(),
    packageMetadata(),
    pinnedNodeVersion(),
    findJavaHome(environment),
    findGhidraHome(environment),
    findJadxJar(environment),
    findPwntoolsPython(environment),
    missingRuntimeFiles(),
    resolveExecutables(
      [
        "objdump",
        "file",
        "unzip",
        "zip",
        "ps",
        "sqlite3",
        "tshark",
        "apktool",
        "gdb",
        "chromium",
        "chromium-browser",
        "wasm-validate",
        "prlimit",
      ],
      environment.PATH,
    ),
  ]);

  const enginesRange = pkg.engines?.node ?? ">=22";
  const pinnedMatches =
    pinned !== undefined && process.versions.node === pinned;
  const nodeOk =
    pinnedMatches || satisfiesEngines(process.versions.node, enginesRange);
  const missingDependencies = !existsSync(
    join(repoRoot, "node_modules", "typescript"),
  );
  let dependenciesStale = false;
  if (!missingDependencies) {
    try {
      const [lock, installed] = await Promise.all([
        stat(join(repoRoot, "package-lock.json")),
        stat(join(repoRoot, "node_modules", ".package-lock.json")),
      ]);
      dependenciesStale = lock.mtimeMs > installed.mtimeMs;
    } catch {
      dependenciesStale = false;
    }
  }
  const runtimeOk = runtimeMissing.length === 0;
  let apktool = environment.REA_APKTOOL_COMMAND ?? found.apktool;
  if (apktool === undefined) {
    const candidate = join(root, "apktool", "apktool");
    if (await isExecutable(candidate)) apktool = candidate;
  }
  // apksigner sits beside apktool in the provisioned tree, not necessarily
  // beside the wrapper that landed on PATH.
  const apksigner = [
    apktool === undefined ? undefined : join(dirname(apktool), "apksigner.jar"),
    join(root, "apktool", "apksigner.jar"),
  ].find((candidate) => candidate !== undefined && existsSync(candidate));
  const androidOk = resolvedJava !== undefined && resolvedJadx !== undefined;
  const deepOk = resolvedJava !== undefined && resolvedGhidra !== undefined;
  const requiredTools = ["objdump", "file", "unzip", "zip", "ps", "sqlite3"];
  const missingTools = requiredTools.filter(
    (name) => found[name] === undefined,
  );
  const optionalMissing = ["tshark", "apktool"].filter(
    (name) =>
      found[name] === undefined &&
      environment.REA_APKTOOL_COMMAND === undefined,
  );
  const { heap, ts } = heapBudget(host.memory_mib + host.swap_mib);

  const checks = [
    statusRow({
      id: "node",
      label: "node",
      required: true,
      ok: nodeOk,
      detail: pinnedMatches
        ? `${process.version} (pinned ${pinned})`
        : `${process.version}${pinned ? ` (pinned ${pinned})` : ""}`,
      hint: nodeOk ? undefined : "node scripts/sandbox.mjs install",
    }),
    statusRow({
      id: "dependencies",
      label: "dependencies",
      required: true,
      ok: !missingDependencies && !dependenciesStale,
      detail: missingDependencies
        ? "node_modules/typescript absent"
        : dependenciesStale
          ? "node_modules older than package-lock.json"
          : "node_modules installed",
      hint:
        missingDependencies || dependenciesStale
          ? "node scripts/sandbox.mjs install"
          : undefined,
    }),
    statusRow({
      id: "runtime",
      label: "runtime",
      required: true,
      ok: runtimeOk,
      detail: runtimeOk
        ? `built (${pkg.name}@${pkg.version})`
        : `missing ${runtimeMissing[0]}`,
      hint: runtimeOk ? undefined : "node scripts/sandbox.mjs install",
    }),
    statusRow({
      id: "env-file",
      label: "env-file",
      ok: environmentInfo.loaded,
      detail: environmentInfo.loaded
        ? environmentInfo.path
        : ".rea-sandbox.env absent (defaults still apply)",
      hint: environmentInfo.loaded
        ? undefined
        : "node scripts/sandbox.mjs env --write",
    }),
    statusRow({
      id: "jdk",
      label: "jdk",
      profile: "android",
      ok: resolvedJava !== undefined,
      detail: resolvedJava ?? "no JDK 25+ found",
      hint:
        resolvedJava === undefined
          ? "node scripts/sandbox.mjs install --profile native"
          : undefined,
    }),
    statusRow({
      id: "android-engines",
      label: "android-engines",
      profile: "android",
      ok: androidOk,
      detail: androidOk
        ? `JADX + JDK ready${apktool ? "" : " (apktool missing)"}`
        : !resolvedJava
          ? "needs JDK 25+"
          : "jadx-headless-mcp jar not found",
      hint: androidOk ? undefined : "node scripts/sandbox.mjs install",
    }),
    statusRow({
      id: "deep-analysis",
      label: "deep-analysis",
      profile: "native",
      ok: deepOk,
      detail: deepOk
        ? `Ghidra ${resolvedGhidra.split("/").at(-1)}`
        : "no Ghidra install",
      hint: deepOk
        ? undefined
        : "node scripts/sandbox.mjs install --profile native",
    }),
    statusRow({
      id: "pwntools",
      label: "pwntools",
      ok: resolvedPwntools !== undefined,
      detail: resolvedPwntools ?? "REA_PWNTOOLS_PYTHON unset",
      hint:
        resolvedPwntools === undefined
          ? "node scripts/sandbox.mjs install"
          : undefined,
    }),
    statusRow({
      id: "host-tools",
      label: "host-tools",
      ok: missingTools.length === 0,
      detail:
        missingTools.length === 0
          ? `objdump, file, zip, sqlite3 ready${
              optionalMissing.length > 0
                ? ` (optional missing: ${optionalMissing.join(", ")})`
                : ""
            }`
          : `missing ${missingTools.join(", ")}`,
      hint:
        missingTools.length > 0
          ? "node scripts/sandbox.mjs install (apt-get) or --no-apt"
          : undefined,
    }),
    statusRow({
      id: "memory",
      label: "memory",
      ok: host.memory_mib + host.swap_mib >= 2048,
      detail:
        host.memory_mib === 0
          ? "unknown (no /proc/meminfo)"
          : `${host.memory_mib} MiB RAM + ${host.swap_mib} MiB swap`,
    }),
    statusRow({
      id: "disk",
      label: "disk",
      ok: host.disk_free_mib === null || host.disk_free_mib >= 2048,
      detail:
        host.disk_free_mib === null
          ? "unknown"
          : `${host.disk_free_mib} MiB free`,
    }),
  ];

  const requiredOk = checks
    .filter((check) => check.required)
    .every((check) => check.ok);

  return {
    checks,
    host,
    environment: environmentInfo,
    packageJson: pkg,
    budget: { heap, ts },
    paths: {
      jdk: resolvedJava,
      ghidra: resolvedGhidra,
      jadx: resolvedJadx,
      pwntools: resolvedPwntools,
      apktool,
      apksigner,
      gdb: found.gdb,
      chromium: found.chromium ?? found["chromium-browser"],
      wasmValidate: found["wasm-validate"],
      prlimit: found.prlimit,
      tshark: found.tshark,
    },
    ready: requiredOk,
    androidAnalysis: androidOk,
    deepAnalysis: deepOk,
    pinnedNode: pinned,
    enginesRange,
  };
}

function statusPayload(status, command = "status") {
  const row = (id) => status.checks.find((check) => check.id === id);
  return {
    schema_version: 2,
    command,
    generated_at: new Date().toISOString(),
    platform: `${process.platform}/${process.arch}`,
    node: {
      ok: row("node")?.ok === true,
      want: status.pinnedNode ?? status.enginesRange,
      have: process.versions.node,
    },
    ready: status.ready,
    android_analysis: status.androidAnalysis,
    deep_analysis: status.deepAnalysis,
    dependencies: row("dependencies")?.ok === true,
    runtime: row("runtime")?.ok === true,
    env_file: status.environment.loaded,
    jdk: status.paths.jdk ?? "",
    jadx: status.paths.jadx ?? "",
    ghidra: status.paths.ghidra ?? "",
    pwntools: status.paths.pwntools ?? "",
    host: status.host,
    budget: status.budget,
    checks: status.checks,
    duration_ms: Math.round(performance.now() - startedAt),
  };
}

function verdict(status) {
  if (!status.ready) return { ok: false, text: "NEEDS PROVISIONING" };
  if (status.deepAnalysis)
    return {
      ok: true,
      text: "READY: engine-free analysis + Ghidra deep analysis",
    };
  if (status.androidAnalysis)
    return { ok: true, text: "READY: engine-free analysis + Android engines" };
  return {
    ok: true,
    text: "READY: engine-free analysis (add Ghidra: install --profile native)",
  };
}

function renderStatus(status) {
  const lines = [];
  lines.push(
    `${bold("REA sandbox status")} ${dim(
      `— ${process.platform}/${process.arch} · node ${process.versions.node} · ${new Date()
        .toISOString()
        .slice(0, 19)
        .replace("T", " ")}`,
    )}`,
  );
  lines.push("");
  for (const check of status.checks) {
    const badge = check.ok
      ? green("ok     ")
      : check.required
        ? red("missing")
        : yellow("warn   ");
    lines.push(
      `  ${badge} ${check.label.padEnd(17)} ${dim(check.detail ?? "")}`,
    );
  }
  lines.push("");
  lines.push(
    dim(
      `host: ${status.host.cpus} vCPU · ${status.host.memory_mib} MiB RAM · ${status.host.swap_mib} MiB swap · ${
        status.host.disk_free_mib ?? "?"
      } MiB free`,
    ),
  );
  const hints = status.checks.filter(
    (check) => !check.ok && check.hint !== undefined,
  );
  if (hints.length > 0) {
    lines.push("");
    lines.push(bold("Next:"));
    const seen = new Set();
    for (const hint of hints) {
      if (seen.has(hint.hint)) continue;
      seen.add(hint.hint);
      lines.push(`  ${hint.hint}`);
    }
  }
  const state = verdict(status);
  lines.push("");
  lines.push(state.ok ? green(state.text) : yellow(state.text));
  return lines.join("\n");
}

async function statusCommand(argv) {
  const { options } = parseOptions(argv, {
    ...COMMON_OPTIONS,
    strict: "boolean",
  });
  if (options.help) return printCommandHelp("status");
  const status = await gatherStatus();

  if (wantsJson(options) && typeof options.json !== "string") {
    process.stdout.write(`${JSON.stringify(statusPayload(status), null, 2)}\n`);
  } else {
    if (!options.quiet) process.stdout.write(`${renderStatus(status)}\n`);
    if (typeof options.json === "string") {
      const target = await writeJsonFile(options.json, statusPayload(status));
      if (!options.quiet)
        process.stdout.write(`${dim(`report written to ${target}`)}\n`);
    }
  }
  if (options.timings) printTimings();
  if (!status.ready) return 1;
  if (options.strict === true && !status.deepAnalysis) return 1;
  return 0;
}

function printTimings() {
  process.stderr.write(
    `${JSON.stringify({
      rea_sandbox_timings: {
        version: 1,
        command_ms: Math.round(performance.now() - startedAt),
      },
    })}\n`,
  );
}

// ------------------------------------------------------------------- verify

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

/** Deterministic minimal Hermes v90 bytecode image with a verified SHA-1 footer. */
function minimalHermesV90Bundle() {
  const fnName = Buffer.from("sandboxHermesMain", "latin1");
  const strLiteral = Buffer.from("sandbox-hermes-probe", "latin1");
  const stringStorage = Buffer.concat([fnName, strLiteral]);
  const pad4 = (length) => (length % 4 === 0 ? 0 : 4 - (length % 4));
  const storagePad = Buffer.alloc(pad4(stringStorage.length));
  const bytecode = Buffer.from([0x24, 0x00, 0x32, 0x00]); // LoadConstUndefined r0; Ret r0

  const fnOffset =
    128 + 16 + 8 + 4 + 8 + stringStorage.length + storagePad.length;
  const totalBytes = fnOffset + bytecode.length + 20;
  const buffer = Buffer.alloc(totalBytes);

  buffer.writeBigUInt64LE(0x1f1903c103bc1fc6n, 0);
  buffer.writeUInt32LE(90, 8);
  createHash("sha1").update("sandbox-source").digest().copy(buffer, 12);
  buffer.writeUInt32LE(totalBytes, 32);
  buffer.writeUInt32LE(0, 36);
  buffer.writeUInt32LE(1, 40);
  buffer.writeUInt32LE(2, 44);
  buffer.writeUInt32LE(1, 48);
  buffer.writeUInt32LE(2, 52);
  buffer.writeUInt32LE(0, 56);
  buffer.writeUInt32LE(stringStorage.length, 60);
  buffer.writeUInt8(0x01, 108);

  buffer.writeUInt32LE((fnOffset & 0x1ffffff) | ((1 & 0x7f) << 25), 128);
  buffer.writeUInt32LE((bytecode.length & 0x7fff) | ((0 & 0x1ffff) << 15), 132);
  buffer.writeUInt32LE((0 & 0x1ffffff) | ((1 & 0x7f) << 25), 136);
  buffer.writeUInt8(0x02 << 0, 143);

  buffer.writeUInt32LE(0x80_00_00_01, 144);
  buffer.writeUInt32LE(0x00_00_00_01, 148);

  buffer.writeUInt32LE(0x12_34_56_78, 152);

  buffer.writeUInt32LE(
    ((0 & 0x7f_ff_ff) << 1) | ((fnName.length & 0xff) << 24),
    156,
  );
  buffer.writeUInt32LE(
    ((fnName.length & 0x7f_ff_ff) << 1) | ((strLiteral.length & 0xff) << 24),
    160,
  );

  stringStorage.copy(buffer, 164);
  bytecode.copy(buffer, fnOffset);

  createHash("sha1")
    .update(buffer.subarray(0, totalBytes - 20))
    .digest()
    .copy(buffer, totalBytes - 20);
  return buffer;
}

async function writeFileInTree(base, name, contents) {
  const path = join(base, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function buildFixtures(environment) {
  const root = await mkdtemp(join(tmpdir(), "rea-sandbox-fixtures-"));
  const workspace = {
    root,
    elf: null,
    zip: join(root, "fixture.zip"),
    apk: join(root, "fixture.apk"),
    sqlite: null,
    javascript: join(root, "javascript-app"),
    wasm: join(root, "empty.wasm"),
  };

  const source = join(root, "fixture.c");
  await writeFile(source, FIXTURE_C_SOURCE);
  const compiled = join(root, "fixture");
  const build = await runCommand("cc", ["-O1", "-o", compiled, source], {
    environment,
    timeoutMs: 60_000,
    cwd: root,
  });
  if (build.status === 0 && existsSync(compiled)) workspace.elf = compiled;
  else if (existsSync("/bin/ls")) workspace.elf = "/bin/ls";

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

  await writeFile(
    workspace.apk,
    storedZip([
      {
        name: "AndroidManifest.xml",
        data: Buffer.from([0x03, 0x00, 0x08, 0x00, 0x08, 0x00, 0x00, 0x00]),
      },
      {
        name: "assets/index.android.bundle",
        data: minimalHermesV90Bundle(),
      },
    ]),
  );

  try {
    const sqliteModule = await import("node:sqlite");
    if (typeof sqliteModule.DatabaseSync === "function") {
      const sqlitePath = join(root, "fixture.sqlite");
      const database = new sqliteModule.DatabaseSync(sqlitePath);
      database.exec(
        "CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT); INSERT INTO items VALUES (1, 'sandbox');",
      );
      database.close();
      workspace.sqlite = sqlitePath;
    }
  } catch {
    workspace.sqlite = null;
  }

  for (const [name, contents] of Object.entries(FIXTURE_JS))
    await writeFileInTree(workspace.javascript, name, contents);
  await writeFile(
    workspace.wasm,
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
  );
  return workspace;
}

function probeMatrix({ quick }) {
  const list = [
    { id: "cli", label: "CLI version report", args: ["--version"], core: true },
    {
      id: "doctor",
      label: "Env doctor",
      args: ["doctor", "--json"],
      core: true,
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
      id: "apk-signature",
      label: "APK signature (pure)",
      args: ["inspect-apk-signature", "<apk>"],
      core: true,
      needs: "apk",
    },
    {
      id: "hermes-bytecode",
      label: "Hermes bytecode (pure)",
      args: ["inspect-hermes-bytecode", "<apk>"],
      core: true,
      needs: "apk",
    },
    {
      id: "sqlite",
      label: "SQLite database (node:sqlite)",
      args: ["inspect-sqlite-database", "<sqlite>"],
      core: true,
      needs: "sqlite",
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
    { id: "pcap", label: "TShark client", args: ["inspect-pcap-client"] },
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
}

const NEEDS_CODE = {
  provider_unavailable: "needs-config",
  capability_unavailable: "needs-config",
  unsupported_host: "unsupported",
  invalid_request: "bug",
  VALIDATION_ERROR: "bug",
  UNKNOWN: "bug",
};

/** First JSON object printed by the CLI, ignoring log lines around it. */
function firstJsonObject(text) {
  for (const line of text.trim().split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch {
      // Keep scanning: the CLI may log a JSON-looking line before the record.
    }
  }
  return null;
}

function classifyProbe(probe, result) {
  if (result.timedOut)
    return {
      status: "timeout",
      detail: `exceeded ${probe.timeoutMs} ms`,
      error: "timeout",
    };
  const payload = firstJsonObject(result.stdout);
  const summary =
    payload === null ? null : (probe.summarize?.(payload) ?? null);
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
      code: code ?? undefined,
      evidence_id: payload?.evidence_id,
    };
  }
  const mapped = NEEDS_CODE[code] ?? (probe.tolerateFailure ? "ok" : "failed");
  return {
    status: mapped,
    detail: (summary ?? [code, message].filter(Boolean).join(": ")).slice(
      0,
      150,
    ),
    code: code ?? undefined,
  };
}

/** Bounded-concurrency map that preserves input order. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(Math.max(limit, 1), items.length) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

function runCommand(
  command,
  args,
  {
    environment = process.env,
    timeoutMs = 0,
    cwd = repoRoot,
    maxStdout = 2_000_000,
    maxStderr = 200_000,
  } = {},
) {
  return new Promise((resolvePromise) => {
    const started = performance.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer;
    let child;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolvePromise({
        status,
        stdout,
        stderr,
        timedOut,
        ms: Math.round(performance.now() - started),
      });
    };
    try {
      child = spawn(command, args, {
        cwd,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      stderr += String(error);
      finish(-1);
      return;
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
    }
    child.stdout.on("data", (chunk) => {
      if (stdout.length < maxStdout) stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < maxStderr) stderr += String(chunk);
    });
    child.on("error", (error) => {
      stderr += String(error);
      finish(-1);
    });
    child.on("close", (status, signal) =>
      finish(signal === null ? (status ?? -1) : -1),
    );
  });
}

const fixturePath = (argument, fixtures) => {
  switch (argument) {
    case "<elf>":
      return fixtures.elf;
    case "<zip>":
      return fixtures.zip;
    case "<apk>":
      return fixtures.apk;
    case "<sqlite>":
      return fixtures.sqlite;
    case "<javascript>":
      return fixtures.javascript;
    case "<wasm>":
      return fixtures.wasm;
    default:
      return argument;
  }
};

function environmentChecks(environment) {
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
    javaHome ?? "JAVA_HOME unset (JADX/apktool/Ghidra need a 64-bit JDK)",
  );
  const apktool = environment.REA_APKTOOL_COMMAND;
  note(
    "apktool",
    apktool !== undefined && existsSync(apktool),
    apktool ?? "REA_APKTOOL_COMMAND unset",
  );
  const jadxJar = environment.REA_JADX_MCP_JAR;
  note(
    "jadx",
    jadxJar !== undefined && existsSync(jadxJar),
    jadxJar ?? "REA_JADX_MCP_JAR unset",
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
}

/**
 * Capability matrix. Probes run concurrently (bounded), so a `--quick` verify
 * costs roughly one CLI start instead of fifteen.
 */
async function runVerification({
  quick = false,
  timeoutMs = 120_000,
  concurrency,
  filter,
} = {}) {
  await assertRuntimeBuilt();
  const { environment, loaded } = await sandboxEnvironment();
  const fixtures = await buildFixtures(environment);
  const started = performance.now();
  const selected = probeMatrix({ quick }).filter((probe) => {
    if (filter === undefined) return true;
    const needle = filter.toLowerCase();
    return (
      probe.id.toLowerCase().includes(needle) ||
      probe.label.toLowerCase().includes(needle)
    );
  });

  let table;
  try {
    table = await mapLimit(
      selected,
      concurrency ?? (quick ? 4 : 2),
      async (probe) => {
        const missing =
          (probe.needs === "elf" && fixtures.elf === null) ||
          (probe.needs === "sqlite" && fixtures.sqlite === null);
        if (missing) {
          return {
            id: probe.id,
            label: probe.label,
            status: "skipped",
            detail: `missing ${probe.needs} fixture prerequisite`,
            ms: 0,
          };
        }
        const resolved = resolveTimeout(probe, timeoutMs);
        const args = probe.args.map((argument) =>
          fixturePath(argument, fixtures),
        );
        const result = await runCommand(
          process.execPath,
          ["scripts/rea.mjs", ...args, "--json"],
          { environment, timeoutMs: resolved },
        );
        const classified = classifyProbe(
          { ...probe, timeoutMs: resolved },
          result,
        );
        return {
          id: probe.id,
          label: probe.label,
          ...classified,
          ms: result.ms,
          args,
        };
      },
    );
  } finally {
    await rm(fixtures.root, { recursive: true, force: true });
  }

  return {
    table,
    checks: environmentChecks(environment),
    loaded,
    durationMs: Math.round(performance.now() - started),
    quick,
  };
}

function resolveTimeout(probe, base) {
  return base * (probe.timeoutScale ?? 1);
}

function summarizeTable(table) {
  const count = (status) => table.filter((row) => row.status === status).length;
  return {
    total: table.length,
    ok: count("ok"),
    needs_config: count("needs-config"),
    unsupported: count("unsupported"),
    failed: count("failed") + count("bug") + count("timeout"),
    skipped: count("skipped"),
  };
}

function renderVerification(report) {
  const { table, checks, durationMs } = report;
  const summary = summarizeTable(table);
  const badge = (status) => {
    switch (status) {
      case "ok":
        return green("ok");
      case "needs-config":
        return yellow("needs-config");
      case "unsupported":
        return dim("unsupported");
      case "skipped":
        return dim("skipped");
      default:
        return red(status);
    }
  };
  const lines = [
    "",
    bold("REA sandbox capability report"),
    dim(
      `${process.platform}/${process.arch} · node ${process.versions.node} · ${new Date().toISOString()}`,
    ),
    dim(
      report.loaded
        ? "environment: .rea-sandbox.env"
        : "environment: process env only",
    ),
    "",
    "| capability | status | detail |",
    "| --- | --- | --- |",
  ];
  for (const row of table) {
    lines.push(`| ${row.label} | ${badge(row.status)} | ${row.detail ?? ""} |`);
  }
  lines.push(
    "",
    "| environment check | state | detail |",
    "| --- | --- | --- |",
  );
  for (const check of checks) {
    lines.push(
      `| ${check.label} | ${check.ok ? green("ok") : yellow("attention")} | ${check.detail} |`,
    );
  }
  const slowest = [...table].sort((left, right) => right.ms - left.ms)[0];
  lines.push("");
  lines.push(
    `${summary.ok}/${summary.total} capabilities verified on this host; ${summary.failed} failed; ${summary.needs_config} need configuration.`,
  );
  lines.push(
    dim(
      `probe wall time ${durationMs} ms${
        slowest !== undefined && slowest.ms > 0
          ? ` · slowest: ${slowest.label} (${slowest.ms} ms)`
          : ""
      }`,
    ),
  );
  return lines.join("\n");
}

async function verifyCommand(argv) {
  const { options } = parseOptions(argv, {
    ...COMMON_OPTIONS,
    quick: "boolean",
    all: "boolean",
    filter: "string",
    timeout: "string",
    concurrency: "string",
    out: "string",
  });
  if (options.help) return printCommandHelp("verify");
  const timeoutMs = Number(options.timeout ?? "120000");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new UsageError("--timeout needs a positive number of milliseconds");
  const concurrency =
    options.concurrency === undefined ? undefined : Number(options.concurrency);
  if (
    concurrency !== undefined &&
    (!Number.isFinite(concurrency) || concurrency < 1)
  )
    throw new UsageError("--concurrency needs a positive number");

  const quick = options.quick === true || options.all !== true;
  const report = await runVerification({
    quick,
    timeoutMs,
    concurrency,
    filter: options.filter,
  });
  const summary = summarizeTable(report.table);
  const payload = {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    platform: `${process.platform}/${process.arch}`,
    node: process.versions.node,
    used_sandbox_env_file: report.loaded,
    quick,
    duration_ms: report.durationMs,
    environment_checks: report.checks,
    capabilities: report.table,
    summary,
  };

  const outPath = options.out ?? writesJsonFile(options);
  if (
    wantsJson(options) &&
    typeof options.json !== "string" &&
    outPath === undefined
  ) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    if (!options.quiet) process.stdout.write(`${renderVerification(report)}\n`);
    if (outPath !== undefined) {
      const target = await writeJsonFile(outPath, payload);
      if (!options.quiet)
        process.stdout.write(`${dim(`report written to ${target}`)}\n`);
    }
  }
  if (options.timings) printTimings();
  return summary.failed > 0 || summary.total === 0 ? 1 : 0;
}

// ------------------------------------------------------------------ install

const PROFILES = {
  agent: [],
  native: ["--with-native"],
  minimal: ["--minimal"],
  gdb: ["--with-gdb"],
  browser: ["--with-browser"],
  full: ["--with-native", "--with-gdb", "--with-browser"],
};

async function installCommand(argv) {
  const { options } = parseOptions(argv, {
    ...COMMON_OPTIONS,
    profile: "string",
    "with-native": "boolean",
    minimal: "boolean",
    "no-apt": "boolean",
    "no-build": "boolean",
    "with-gdb": "boolean",
    "with-browser": "boolean",
    root: "string",
    plan: "boolean",
    "dry-run": "boolean",
    force: "boolean",
    "no-verify": "boolean",
  });
  if (options.help) return printCommandHelp("install");

  const profile = options.profile ?? "agent";
  if (PROFILES[profile] === undefined)
    throw new UsageError(
      `unknown profile: ${profile} (expected ${Object.keys(PROFILES).join(", ")})`,
    );

  const passthrough = [...PROFILES[profile]];
  for (const flag of [
    "--with-native",
    "--minimal",
    "--no-apt",
    "--no-build",
    "--with-gdb",
    "--with-browser",
  ]) {
    if (options[flag.slice(2)] === true) passthrough.push(flag);
  }
  const planOnly = options.plan === true || options["dry-run"] === true;
  if (planOnly) passthrough.push("--check");
  if (options.root !== undefined) passthrough.push("--root", options.root);

  const jsonStdout = wantsJson(options) && typeof options.json !== "string";
  const status = await gatherStatus();
  const wantsNative = passthrough.includes("--with-native");
  const wantsMinimal = passthrough.includes("--minimal");
  // Extras are part of the request: asking for gdb or Chromium on a ready host
  // still has to provision.
  const extrasReady =
    (!passthrough.includes("--with-gdb") || status.paths.gdb !== undefined) &&
    (!passthrough.includes("--with-browser") ||
      status.paths.chromium !== undefined);
  const satisfied =
    extrasReady &&
    status.ready &&
    (wantsMinimal || !wantsNative || status.deepAnalysis);
  if (satisfied && options.force !== true && !planOnly) {
    if (!options.quiet && !jsonStdout)
      process.stdout.write(
        `${green("[sandbox]")} already provisioned${
          status.deepAnalysis ? " (with Ghidra)" : ""
        } — nothing to do. Re-run with --force to reinstall.\n`,
      );
    return finishInstall(status, options);
  }

  if (!existsSync(provisionerPath))
    throw new PreflightError(
      `provisioner not found at ${provisionerPath}`,
      "Restore scripts/sandbox/provision-sandbox.sh from git.",
    );

  if (!options.quiet && !jsonStdout)
    process.stdout.write(
      `${cyan("[sandbox]")} provisioning (profile: ${profile}${
        planOnly ? ", plan only" : ""
      }; safe to re-run)\n`,
    );
  const result = spawnSync("bash", [provisionerPath, ...passthrough], {
    cwd: repoRoot,
    // With --json, keep stdout machine-readable and stream progress on stderr.
    stdio: jsonStdout ? ["inherit", 2, 2] : "inherit",
    env: {
      ...process.env,
      PATH: `/usr/local/bin:${process.env.PATH ?? ""}`,
    },
  });
  if (result.status !== 0)
    throw new PreflightError(
      `provisioner exited with status ${result.status ?? "signal"}.`,
      "Read the failing step above; docs/sandbox-environment.md has the troubleshooting ladder.",
    );

  const provisioned = await gatherStatus();
  if (planOnly) {
    if (jsonStdout)
      process.stdout.write(
        `${JSON.stringify(
          {
            schema_version: 2,
            command: "install",
            plan: true,
            profile,
            provisioner_arguments: passthrough,
            status: statusPayload(provisioned, "install"),
          },
          null,
          2,
        )}\n`,
      );
    return 0;
  }
  if (options["no-verify"] !== true && provisioned.ready && !jsonStdout) {
    if (!options.quiet)
      process.stdout.write("\n[sandbox] verifying capabilities\n");
    const verification = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "verify", "--quick", "--no-color"],
      { cwd: repoRoot, stdio: "inherit", env: process.env },
    );
    if (verification.status !== 0) {
      process.stderr.write(
        "[sandbox] capability check reported failures; see the rows above\n",
      );
      return 1;
    }
  }
  return finishInstall(provisioned, options);
}

async function finishInstall(status, options) {
  const payload = statusPayload(status, "install");
  if (wantsJson(options) && typeof options.json !== "string") {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (typeof options.json === "string") {
    const target = await writeJsonFile(options.json, payload);
    if (!options.quiet)
      process.stdout.write(`${dim(`status written to ${target}`)}\n`);
  } else if (!options.quiet) {
    process.stdout.write(
      [
        "",
        `${green("[sandbox] ready")}${status.deepAnalysis ? " (Ghidra included)" : ""}`,
        "  node scripts/sandbox.mjs run analyze /abs/path/to/binary --json",
        "  node scripts/sandbox.mjs run analyze-javascript-application /abs/path/to/app --json",
        dim(
          "  .rea-sandbox.env now loads automatically; no `source` step needed.",
        ),
        "",
      ].join("\n"),
    );
  }
  if (options.timings) printTimings();
  return status.ready ? 0 : 1;
}

// ---------------------------------------------------------------------- run

async function runCli(argv) {
  let timings = false;
  let loadEnvironment = true;
  let index = 0;
  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      index += 1;
      break;
    }
    if (argument === "--timings") {
      timings = true;
      continue;
    }
    if (argument === "--no-env") {
      loadEnvironment = false;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return printCommandHelp("run");
    }
    break;
  }
  const forwarded = argv.slice(index);
  if (forwarded.length === 0) {
    printCommandHelp("run");
    return 2;
  }

  await assertRuntimeBuilt();
  const { environment, loaded } = await sandboxEnvironment();
  const childEnvironment = loadEnvironment ? environment : { ...process.env };
  if (!loaded && loadEnvironment)
    process.stderr.write(
      "[sandbox] no .rea-sandbox.env yet; using the current environment. " +
        "Run `node scripts/sandbox.mjs install` once.\n",
    );

  const child = spawn(process.execPath, [cliPath, ...forwarded], {
    cwd: process.cwd(),
    env: childEnvironment,
    stdio: "inherit",
  });
  const status = await new Promise((resolvePromise) => {
    child.on("error", (error) => {
      process.stderr.write(`${error}\n`);
      resolvePromise(1);
    });
    child.on("close", (code, signal) =>
      resolvePromise(signal === null ? (code ?? 1) : 1),
    );
  });
  if (timings) printTimings();
  return status;
}

// -------------------------------------------------------------------- batch

/** Split one command line into argv, honouring single and double quotes. */
function tokenize(line) {
  const tokens = [];
  let current = "";
  let started = false;
  let quote;
  let escaping = false;
  for (const character of line) {
    if (escaping) {
      current += character;
      escaping = false;
      started = true;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (character === " " || character === "\t") {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

function normalizeTask(entry, index) {
  if (Array.isArray(entry) && entry.every((part) => typeof part === "string"))
    return { argv: entry };
  if (typeof entry === "string") return { argv: tokenize(entry) };
  if (entry !== null && typeof entry === "object") {
    const argv =
      entry.argv ??
      (typeof entry.command === "string" ? tokenize(entry.command) : undefined);
    if (Array.isArray(argv) && argv.every((part) => typeof part === "string"))
      return { argv, label: entry.label };
  }
  throw new UsageError(
    `task ${index} is not a command (expected an array of arguments or a string)`,
  );
}

async function readTasksFromFile(path) {
  let text;
  try {
    text = await readFile(resolve(process.cwd(), path), "utf8");
  } catch (cause) {
    throw new PreflightError(
      `cannot read task file ${path}: ${cause?.code ?? cause}`,
      'Pass an existing file, or use --task "<command ...>" for an inline task.',
    );
  }
  const trimmed = text.trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed))
      throw new UsageError("task file JSON must be an array");
    return parsed.map((entry, index) => normalizeTask(entry, index));
  }
  const tasks = [];
  let index = 0;
  for (const line of trimmed.split("\n")) {
    const stripped = line.trim();
    if (stripped === "" || stripped.startsWith("#")) continue;
    tasks.push(normalizeTask(stripped, index));
    index += 1;
  }
  return tasks;
}

async function batchCommand(argv) {
  const { options, positionals } = parseOptions(argv, {
    ...COMMON_OPTIONS,
    file: "string",
    task: "string[]",
    out: "string",
    concurrency: "string",
    timeout: "string",
    "fail-fast": "boolean",
  });
  if (options.help) return printCommandHelp("batch");

  const tasks = [];
  if (options.file !== undefined)
    tasks.push(...(await readTasksFromFile(options.file)));
  for (const task of options.task ?? [])
    tasks.push(normalizeTask(task, tasks.length));
  for (const positional of positionals)
    tasks.push({ argv: tokenize(positional) });
  if (tasks.length === 0)
    throw new UsageError(
      'no tasks: pass --file <path>, --task "<command ...>" or one quoted command per positional',
    );
  const empty = tasks.findIndex((task) => task.argv.length === 0);
  if (empty !== -1) throw new UsageError(`task ${empty} has no command`);

  await assertRuntimeBuilt();
  const { environment } = await sandboxEnvironment();
  const timeoutMs = Number(options.timeout ?? "600000");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new UsageError("--timeout needs a positive number of milliseconds");
  const nativePresent = tasks.some((task) => NATIVE_COMMANDS.has(task.argv[0]));
  const requested =
    options.concurrency === undefined ? undefined : Number(options.concurrency);
  if (requested !== undefined && (!Number.isFinite(requested) || requested < 1))
    throw new UsageError("--concurrency needs a positive number");
  // Two concurrent Ghidra imports exhaust a 2 GiB host, so native sweeps stay
  // serial unless the caller overrides it explicitly.
  const concurrency = requested ?? (nativePresent ? 1 : 2);
  const jsonStdout = wantsJson(options) && typeof options.json !== "string";

  if (!options.quiet && !jsonStdout)
    process.stdout.write(
      `${cyan("[sandbox]")} running ${tasks.length} command(s) with concurrency ${concurrency}\n`,
    );

  let failedEnough = false;
  const results = await mapLimit(tasks, concurrency, async (task, index) => {
    if (failedEnough)
      return { index, argv: task.argv, status: "skipped", ms: 0 };
    const result = await runCommand(process.execPath, [cliPath, ...task.argv], {
      environment,
      timeoutMs,
      cwd: process.cwd(),
    });
    const classified = classifyProbe({ ...task, timeoutMs }, result);
    if (options["fail-fast"] === true && classified.status !== "ok")
      failedEnough = true;
    return {
      index,
      label: task.label ?? task.argv[0],
      argv: task.argv,
      status: classified.status,
      detail: classified.detail,
      code: classified.code,
      evidence_id: classified.evidence_id,
      exit_code: result.status,
      ms: result.ms,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });

  const failed = results.filter(
    (row) => row.status !== "ok" && row.status !== "skipped",
  );
  if (!options.quiet && !jsonStdout) {
    const lines = ["", bold("batch results"), ""];
    for (const row of results) {
      const badge =
        row.status === "ok"
          ? green("ok   ")
          : row.status === "skipped"
            ? dim("skip ")
            : red(row.status.padEnd(5));
      lines.push(
        `  ${badge} ${String(row.ms).padStart(7)} ms  ${row.label ?? row.argv[0]}`,
      );
    }
    lines.push("");
    lines.push(
      `${results.length - failed.length}/${results.length} succeeded${
        failed.length > 0
          ? `; ${failed.length} failed (first: ${failed[0].label ?? failed[0].argv.join(" ")})`
          : ""
      }`,
    );
    process.stdout.write(`${lines.join("\n")}\n`);
  }

  const outPath = options.out;
  if (outPath !== undefined) {
    const target = resolve(process.cwd(), outPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      `${results
        .map((row) =>
          JSON.stringify({
            index: row.index,
            label: row.label,
            argv: row.argv,
            status: row.status,
            exit_code: row.exit_code ?? null,
            ms: row.ms,
            evidence_id: row.evidence_id ?? null,
            code: row.code ?? null,
            detail: row.detail ?? null,
            stderr_tail:
              row.status === "ok"
                ? undefined
                : (row.stderr ?? "").trim().split("\n").slice(-3).join("\n"),
            stdout: row.status === "ok" ? row.stdout : undefined,
          }),
        )
        .join("\n")}\n`,
    );
    if (!options.quiet && !jsonStdout)
      process.stdout.write(`${dim(`results written to ${target}`)}\n`);
  }

  if (jsonStdout) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schema_version: 2,
          command: "batch",
          concurrency,
          results: results.map(({ stdout, stderr, ...rest }) => rest),
          failed: failed.length,
        },
        null,
        2,
      )}\n`,
    );
  } else if (typeof options.json === "string") {
    const target = await writeJsonFile(options.json, {
      schema_version: 2,
      command: "batch",
      concurrency,
      results: results.map(({ stdout, stderr, ...rest }) => rest),
    });
    if (!options.quiet)
      process.stdout.write(`${dim(`summary written to ${target}`)}\n`);
  }
  if (options.timings) printTimings();
  return failed.length > 0 ? 1 : 0;
}

// --------------------------------------------------------------------- slim

const SLIM_DIRECTORIES = [
  "tests",
  "website",
  "docs/readme",
  "docs/assets",
  "docs/releases",
  "docs/specs",
  "docs/design",
  "docs/public",
  "docs/verification",
  "docs/.vitepress",
  ".github",
  ".husky",
  "examples",
];

const SLIM_FILES = [
  "CHANGELOG.md",
  "stryker.config.mjs",
  "stryker.semantics.config.mjs",
  "vitest.config.ts",
  "vitest.reverse-tools.config.ts",
  "vitest.reverse-tools-semantics.config.ts",
  "knip.json",
  "knip.production.json",
  ".jscpd.json",
  "release-please-config.json",
  ".release-please-manifest.json",
  "tsconfig.reverse-tools-mutation.json",
  "tsconfig.frida-verification.json",
  "scripts/check-doc-facts.mjs",
  "scripts/lib/docs-facts.mjs",
  "scripts/verify-package-setup.mjs",
];

const SOURCE_TEST_PATTERNS = ["src/**/*.test.ts", "src/**/*.fixture.ts"];

function git(args) {
  return spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1_048_576,
  });
}

function gitTrackedSourceTests() {
  const result = git(["ls-files", "-z", "--", ...SOURCE_TEST_PATTERNS]);
  if (result.status !== 0) return [];
  return result.stdout.split("\0").filter((entry) => entry !== "");
}

async function countFiles(path) {
  let entries;
  try {
    entries = await stat(path);
  } catch {
    return 0;
  }
  if (!entries.isDirectory()) return 1;
  let total = 0;
  let children;
  try {
    children = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const child of children) {
    if (child.isDirectory()) total += await countFiles(join(path, child.name));
    else total += 1;
  }
  return total;
}

async function countCheckoutFiles() {
  const skip = new Set([".git", "node_modules", "dist", "build"]);
  let total = 0;
  const queue = [repoRoot];
  while (queue.length > 0) {
    const directory = queue.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else total += 1;
    }
  }
  return total;
}

async function slimCommand(argv) {
  const { options } = parseOptions(argv, {
    ...COMMON_OPTIONS,
    "dry-run": "boolean",
    restore: "boolean",
    "no-source-tests": "boolean",
    force: "boolean",
  });
  if (options.help) return printCommandHelp("slim");

  if (options.restore === true) {
    const trackedTests = gitTrackedSourceTests();
    const paths = [
      ...SLIM_DIRECTORIES,
      ...SLIM_FILES,
      ...(options["no-source-tests"] === true ? [] : trackedTests),
    ];
    const checks = git(["rev-parse", "--is-inside-work-tree"]);
    if (checks.status !== 0)
      throw new PreflightError(
        "not a git work tree; there is nothing to restore from.",
        "Clone the repository again or restore the files from upstream.",
      );
    let restored = 0;
    for (let index = 0; index < paths.length; index += 50) {
      const chunk = paths.slice(index, index + 50);
      const result = git(["checkout", "--", ...chunk]);
      if (result.status === 0) restored += chunk.length;
    }
    if (options.json !== undefined && typeof options.json !== "string") {
      process.stdout.write(
        `${JSON.stringify({ schema_version: 2, command: "slim", restored, paths: paths.length }, null, 2)}\n`,
      );
    } else if (!options.quiet) {
      process.stdout.write(
        restored === 0
          ? `nothing to restore: none of the ${paths.length} profile paths are tracked in this checkout\n${dim(
              "clone upstream morluto/rea for the full development tree",
            )}\n`
          : `restored ${restored}/${paths.length} paths from git\n${dim(
              "rebuild with: node scripts/sandbox.mjs install --no-apt",
            )}\n`,
      );
    }
    return 0;
  }

  const sourceTests =
    options["no-source-tests"] === true ? [] : gitTrackedSourceTests();
  const before = await countCheckoutFiles();
  const targets = [];
  for (const path of [...SLIM_DIRECTORIES, ...SLIM_FILES]) {
    if (existsSync(join(repoRoot, path)))
      targets.push({ path, files: await countFiles(join(repoRoot, path)) });
  }
  const sourceTestFiles = sourceTests.filter((path) =>
    existsSync(join(repoRoot, path)),
  );

  if (options["dry-run"] === true) {
    const total = targets.reduce(
      (sum, target) => sum + target.files,
      sourceTestFiles.length,
    );
    const payload = {
      schema_version: 2,
      command: "slim",
      dry_run: true,
      before,
      targets,
      source_tests: sourceTestFiles.length,
      total,
    };
    if (wantsJson(options) && typeof options.json !== "string") {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else if (!options.quiet) {
      const lines = [bold("would remove:")];
      for (const target of targets)
        lines.push(
          `  ${target.path.padEnd(42)} ${String(target.files).padStart(6)} files`,
        );
      lines.push(
        `  ${"src/**/*.test.ts + *.fixture.ts".padEnd(42)} ${String(sourceTestFiles.length).padStart(6)} files`,
      );
      lines.push("", `total: ${total} files; checkout: ${before} files`);
      process.stdout.write(`${lines.join("\n")}\n`);
    }
    if (typeof options.json === "string")
      await writeJsonFile(options.json, payload);
    return 0;
  }

  const jsonStdout = wantsJson(options) && typeof options.json !== "string";
  let removed = 0;
  const report = [];
  for (const target of targets) {
    await rm(join(repoRoot, target.path), { recursive: true, force: true });
    removed += target.files;
    report.push({ path: target.path, files: target.files });
    if (!options.quiet && !jsonStdout)
      process.stdout.write(
        `  ${target.path.padEnd(42)} ${String(target.files).padStart(6)} files\n`,
      );
  }
  for (const path of sourceTestFiles) {
    await rm(join(repoRoot, path), { force: true });
    removed += 1;
  }
  if (sourceTestFiles.length > 0 && !options.quiet && !jsonStdout)
    process.stdout.write(
      `  ${"src/**/*.test.ts + *.fixture.ts".padEnd(42)} ${String(sourceTestFiles.length).padStart(6)} files\n`,
    );
  const after = await countCheckoutFiles();

  if (wantsJson(options) && typeof options.json !== "string") {
    process.stdout.write(
      `${JSON.stringify(
        {
          schema_version: 2,
          command: "slim",
          before,
          after,
          removed,
          targets: report,
        },
        null,
        2,
      )}\n`,
    );
  } else if (!options.quiet) {
    process.stdout.write(
      [
        "",
        `files: ${before} -> ${after} (${before - after} removed)`,
        `restore with: node scripts/sandbox.mjs slim --restore`,
        "",
      ].join("\n"),
    );
    if (typeof options.json === "string")
      await writeJsonFile(options.json, {
        schema_version: 2,
        command: "slim",
        before,
        after,
        removed,
        targets: report,
      });
  }
  return 0;
}

// ---------------------------------------------------------------------- env

function shellQuote(value) {
  return /^[A-Za-z0-9_./:@%+,=-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

async function deriveEnvironment(status, baseEnvironment) {
  const values = {};
  const pathEntries = [];
  if (status.paths.jdk !== undefined)
    pathEntries.push(join(status.paths.jdk, "bin"));
  pathEntries.push("/usr/local/bin");
  pathEntries.push(...(baseEnvironment.PATH ?? "").split(":"));
  values.PATH = [...new Set(pathEntries.filter((entry) => entry !== ""))].join(
    ":",
  );
  values.NODE_OPTIONS = `--max-old-space-size=${status.budget.heap}`;
  values.REA_TS_MAX_MEMORY = `${status.budget.ts}M`;
  if (status.paths.jdk !== undefined) values.JAVA_HOME = status.paths.jdk;
  if (status.paths.ghidra !== undefined)
    values.GHIDRA_INSTALL_DIR = status.paths.ghidra;
  if (status.paths.pwntools !== undefined)
    values.REA_PWNTOOLS_PYTHON = status.paths.pwntools;
  if (status.paths.jadx !== undefined)
    values.REA_JADX_MCP_JAR = status.paths.jadx;
  if (status.paths.apktool !== undefined)
    values.REA_APKTOOL_COMMAND = status.paths.apktool;
  if (
    status.paths.apksigner !== undefined &&
    existsSync(status.paths.apksigner)
  )
    values.REA_APKSIGNER_JAR = status.paths.apksigner;
  if (status.paths.prlimit !== undefined)
    values.REA_TSHARK_PRLIMIT_COMMAND = status.paths.prlimit;
  if (status.paths.chromium !== undefined)
    values.REA_BROWSER_EXECUTABLE = status.paths.chromium;
  if (status.paths.wasmValidate !== undefined) {
    const version = spawnSync(status.paths.wasmValidate, ["--version"], {
      encoding: "utf8",
    });
    // Only advertise the exact WABT build REA admits; an advertised-but-rejected
    // toolchain produces worse diagnostics than no variable at all.
    if (version.status === 0 && /1[.]0[.]42/.test(version.stdout))
      values.REA_WABT_BIN_DIRECTORY = dirname(status.paths.wasmValidate);
  }
  values.REA_GHIDRA_STARTUP_TIMEOUT_MS = "600000";
  values.REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS = "180";
  values.REA_MCP_MAX_RESPONSE_BYTES = "10485760";
  return values;
}

async function envCommand(argv) {
  const { options } = parseOptions(argv, {
    ...COMMON_OPTIONS,
    shell: "boolean",
    write: "boolean",
    force: "boolean",
  });
  if (options.help) return printCommandHelp("env");
  const status = await gatherStatus();
  const base = process.env;
  const values = await deriveEnvironment(status, base);

  if (options.write === true) {
    const lines = [
      "# Generated by scripts/sandbox.mjs env --write — machine specific.",
      "# Source before running REA:  set -a; . ./.rea-sandbox.env; set +a",
    ];
    for (const [key, value] of Object.entries(values))
      lines.push(`${key}=${shellQuote(value)}`);
    await writeFile(sandboxEnvPath, `${lines.join("\n")}\n`);
    if (wantsJson(options) && typeof options.json !== "string")
      process.stdout.write(
        `${JSON.stringify({ schema_version: 2, command: "env", path: sandboxEnvPath, values }, null, 2)}\n`,
      );
    else if (!options.quiet)
      process.stdout.write(`${green("wrote")} ${sandboxEnvPath}\n`);
    if (typeof options.json === "string")
      await writeJsonFile(options.json, {
        schema_version: 2,
        command: "env",
        path: sandboxEnvPath,
        values,
      });
    return 0;
  }

  if (wantsJson(options) && typeof options.json !== "string") {
    process.stdout.write(
      `${JSON.stringify(
        {
          schema_version: 2,
          command: "env",
          loaded_from_file: status.environment.loaded,
          derived: values,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const prefix = options.shell === true ? "export " : "";
  for (const [key, value] of Object.entries(values))
    process.stdout.write(`${prefix}${key}=${shellQuote(value)}\n`);
  if (typeof options.json === "string")
    await writeJsonFile(options.json, { schema_version: 2, values });
  return 0;
}

// ------------------------------------------------------------------- report

async function reportCommand(argv) {
  const { options } = parseOptions(argv, {
    ...COMMON_OPTIONS,
    quick: "boolean",
    all: "boolean",
    out: "string",
    timeout: "string",
    concurrency: "string",
  });
  if (options.help) return printCommandHelp("report");
  const status = await gatherStatus();
  const verification = await runVerification({
    quick: options.all === true ? false : options.quick !== false,
    timeoutMs: Number(options.timeout ?? "120000"),
    concurrency:
      options.concurrency === undefined
        ? undefined
        : Number(options.concurrency),
  });
  const summary = summarizeTable(verification.table);
  const payload = {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    platform: `${process.platform}/${process.arch}`,
    node: process.versions.node,
    used_sandbox_env_file: verification.loaded,
    quick: verification.quick,
    status: statusPayload(status, "report"),
    environment_checks: verification.checks,
    capabilities: verification.table,
    summary,
  };
  const target = options.out ?? "docs/sandbox-capability-report.json";
  const written = await writeJsonFile(target, payload);
  if (wantsJson(options) && typeof options.json !== "string")
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else if (!options.quiet)
    process.stdout.write(
      [
        `${green("report written")} ${written}`,
        `${summary.ok}/${summary.total} capabilities verified; ${summary.failed} failed; ${summary.needs_config} need configuration.`,
        dim(`base: ${verdict(status).text}`),
        "",
      ].join("\n"),
    );
  if (options.timings) printTimings();
  return summary.failed > 0 ? 1 : 0;
}

// -------------------------------------------------------------- completions

const COMMAND_SUMMARY = [
  ["status", "Readiness report; changes nothing"],
  ["install", "Provision engines and build the runtime"],
  ["verify", "Run the capability matrix on this host"],
  ["run", "Run the REA CLI with the sandbox environment loaded"],
  ["batch", "Run many REA commands with bounded concurrency"],
  ["slim", "Trim or restore the checkout"],
  ["env", "Print, export or write the sandbox environment"],
  ["report", "Write the machine-readable capability report"],
  ["completions", "Print shell completion"],
  ["help", "Show help for a command"],
];

const COMMAND_ALIASES = {
  check: "status",
  doctor: "status",
  setup: "install",
  bootstrap: "install",
  provision: "install",
  test: "verify",
  trim: "slim",
  version: "version",
};

function completionsCommand(argv) {
  const { positionals } = parseOptions(argv, { ...COMMON_OPTIONS });
  const shell = positionals[0] ?? "bash";
  const names = COMMAND_SUMMARY.map(([name]) => name).join(" ");
  if (shell === "bash") {
    process.stdout.write(
      [
        "# REA sandbox completion — add to ~/.bashrc:",
        '#   eval "$(node scripts/sandbox.mjs completions bash)"',
        "_rea_sandbox() {",
        "  local cur prev",
        '  cur="${COMP_WORDS[COMP_CWORD]}"',
        '  prev="${COMP_WORDS[COMP_CWORD-1]}"',
        `  if [ \"$COMP_CWORD\" -eq 1 ]; then COMPREPLY=( $(compgen -W "${names}" -- "$cur") ); return; fi`,
        '  case "$prev" in',
        '    --profile) COMPREPLY=( $(compgen -W "agent native minimal gdb browser full" -- "$cur") ); return ;;',
        '    --file|--out|--root|--json|--markdown) COMPREPLY=( $(compgen -f -- "$cur") ); return ;;',
        '    completions) COMPREPLY=( $(compgen -W "bash zsh" -- "$cur") ); return ;;',
        "  esac",
        "}",
        "complete -F _rea_sandbox sandbox rea-sandbox",
        "",
      ].join("\n"),
    );
    return 0;
  }
  if (shell === "zsh") {
    process.stdout.write(
      [
        "#compdef sandbox rea-sandbox",
        `_rea_sandbox_commands=(${COMMAND_SUMMARY.map(([name, summary]) => `"${name}:${summary}"`).join(" ")})`,
        "_arguments '1:command:->command' '*::arg:->args'",
        "case $state in",
        "  command) _describe 'command' _rea_sandbox_commands ;;",
        "  args) _files ;;",
        "esac",
        "",
      ].join("\n"),
    );
    return 0;
  }
  throw new UsageError(`unknown shell: ${shell} (expected bash or zsh)`);
}

// --------------------------------------------------------------------- help

const HELP = {
  status: `Usage: node scripts/sandbox.mjs status [--json [path]] [--strict]

Cheap, side-effect-free readiness report: node, dependencies, runtime, JDK,
Ghidra, JADX, apktool, pwntools, host tools, memory and disk. No npm, no network.
Exit 0 when the core profile is ready, 1 when provisioning is needed.

  --strict        also require deep analysis (Ghidra)
  --json [path]   machine-readable status; with a path, write it there`,
  install: `Usage: node scripts/sandbox.mjs install [--profile <name>] [options]

Provision what is missing and build the runtime. Idempotent; skips itself when
the requested profile is already satisfied (use --force to reinstall).

  --profile agent|native|minimal|gdb|browser|full   default: agent
  --plan          print the provisioner plan without changing anything
  --json          print the final status document (provisioner output still streams)
  --no-verify     skip the capability check that follows a successful install
  --force         provision even when the profile looks satisfied
  --root <dir>    engine directory (default /opt/rea-engines)

Passthrough: --with-native --minimal --no-apt --no-build --with-gdb --with-browser`,
  verify: `Usage: node scripts/sandbox.mjs verify [--quick] [--all] [options]

Run the capability matrix against generated fixtures on this host. Every "ok"
row is a command that exited 0 with an Evidence record here.

  --quick             core probes only (default)
  --all               add the Ghidra deep-analysis probes
  --filter <text>     only probes whose id or label matches
  --timeout <ms>      per-probe deadline (default 120000; deep probes get 6x)
  --concurrency <n>   parallel probes (default 4 quick, 2 with deep probes)
  --json [path]       JSON output; with a path, write the report there
  --out <path>        write the report to a path`,
  run: `Usage: node scripts/sandbox.mjs run [--timings] [--no-env] <rea command...>

Run the REA CLI with .rea-sandbox.env applied automatically, so no
\`set -a; . ./.rea-sandbox.env; set +a\` step is needed. Exit status is the CLI's.

  node scripts/sandbox.mjs run analyze /abs/path/to/binary --json
  node scripts/sandbox.mjs run -- analyze-javascript-application /abs/app --json`,
  batch: `Usage: node scripts/sandbox.mjs batch --file <path> [options]
       node scripts/sandbox.mjs batch --task "<command ...>" ...

Run many REA commands in one call and report per-command status, timing and
Evidence ids. Task files are JSON arrays (of argv arrays, strings or
{label, argv}) or one command per line. Native commands are serialized.

  --file <path>        task file
  --task <command>     repeatable inline task
  --out <path>         write one JSON record per task (JSONL)
  --concurrency <n>    default 2, or 1 when a task loads Ghidra
  --timeout <ms>       per-command deadline (default 600000)
  --fail-fast          stop scheduling after the first failure`,
  slim: `Usage: node scripts/sandbox.mjs slim [--dry-run | --restore] [options]

Trim the checkout to the agent profile (tests, website, CI, release tooling),
or restore what was trimmed. Nothing that runs during an investigation is
removed: src/, scripts/, bridge/, native/, third_party/, licenses/ and docs/*.md
stay.

  --dry-run          list what would go, change nothing
  --restore          git-checkout everything the profile removes
  --no-source-tests  keep src/**/*.test.ts and *.fixture.ts
  --json [path]      machine-readable summary`,
  env: `Usage: node scripts/sandbox.mjs env [--shell] [--write] [--json]

Derive the sandbox environment from what is actually installed on this host:
PATH, JAVA_HOME, GHIDRA_INSTALL_DIR, REA_PWNTOOLS_PYTHON, JADX/apktool paths,
memory budgets and Ghidra timeouts.

  --shell   prefix every line with \`export \`
  --write   write .rea-sandbox.env (useful after a container lost it)
  --json    JSON document`,
  report: `Usage: node scripts/sandbox.mjs report [--quick] [--out <path>]

Combine status and the capability matrix into one machine-readable report
(default: docs/sandbox-capability-report.json).`,
  completions: `Usage: node scripts/sandbox.mjs completions [bash|zsh]

Print a completion script; load it with
  eval "$(node scripts/sandbox.mjs completions bash)"`,
  help: `Usage: node scripts/sandbox.mjs help [command]`,
};

function printCommandHelp(command) {
  const text = HELP[command];
  if (text === undefined) {
    printHelp();
    return 0;
  }
  process.stdout.write(`${text}\n`);
  return 0;
}

function printHelp() {
  const lines = [
    bold("REA sandbox") +
      dim(" — one command for the headless-sandbox lifecycle"),
    "",
    "Usage: node scripts/sandbox.mjs <command> [options]",
    "",
    "Commands:",
  ];
  const width = Math.max(...COMMAND_SUMMARY.map(([name]) => name.length));
  for (const [name, summary] of COMMAND_SUMMARY)
    lines.push(`  ${name.padEnd(width)}  ${summary}`);
  lines.push(
    "",
    "Common options: --json [path] --no-color --quiet --timings --help",
    "",
    "Examples:",
    "  node scripts/sandbox.mjs status                     # can I analyse yet?",
    "  node scripts/sandbox.mjs install --profile native   # add Ghidra",
    "  node scripts/sandbox.mjs verify --quick             # prove what works",
    "  node scripts/sandbox.mjs run inspect-artifact /abs/a.zip --json",
    "  node scripts/sandbox.mjs batch --file tasks.txt --out results.jsonl",
    "  node scripts/sandbox.mjs slim --dry-run             # file budget",
    "",
    dim(
      "Exit codes: 0 ready/success, 1 not ready or failed probes, 2 usage/preflight.",
    ),
  );
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function versionCommand() {
  const pkg = await packageMetadata();
  process.stdout.write(
    `rea-sandbox (${pkg.name}@${pkg.version}) · node ${process.versions.node} · ${process.platform}/${process.arch}\n`,
  );
  return 0;
}

// --------------------------------------------------------------------- main

async function dispatch(command, argv) {
  switch (command) {
    case "status":
    case "check":
    case "doctor":
      return statusCommand(argv);
    case "install":
    case "setup":
    case "bootstrap":
    case "provision":
      return installCommand(argv);
    case "verify":
    case "test":
      return verifyCommand(argv);
    case "run":
      return runCli(argv);
    case "batch":
      return batchCommand(argv);
    case "slim":
    case "trim":
      return slimCommand(argv);
    case "env":
      return envCommand(argv);
    case "report":
      return reportCommand(argv);
    case "completions":
      return completionsCommand(argv);
    case "help":
      return printCommandHelp(argv[0]);
    case "version":
      return versionCommand();
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

async function main() {
  const [command = "status", ...rest] = rawArgv;
  if (command === "--help" || command === "-h" || command === "help")
    return printCommandHelp(rest[0]);
  if (command === "--version" || command === "-v" || command === "version")
    return versionCommand();

  try {
    // `sandbox --json` and friends read as a status request.
    if (command.startsWith("-")) return await dispatch("status", rawArgv);
    return await dispatch(COMMAND_ALIASES[command] ?? command, rest);
  } catch (cause) {
    if (cause instanceof UsageError) {
      process.stderr.write(`rea-sandbox: ${cause.message}\n`);
      process.stderr.write("run `node scripts/sandbox.mjs help` for usage\n");
      return 2;
    }
    if (cause instanceof PreflightError) {
      process.stderr.write(`rea-sandbox: ${cause.message}\n`);
      if (cause.remediation !== undefined)
        process.stderr.write(`\n  fix: ${cause.remediation}\n`);
      return 2;
    }
    throw cause;
  }
}

process.exitCode = await main();
