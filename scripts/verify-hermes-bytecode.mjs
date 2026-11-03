#!/usr/bin/env node
/**
 * End-to-end CLI + MCP parity verifier for pure-TypeScript Hermes bytecode
 * inspection (`inspect_hermes_bytecode` / `inspect-hermes-bytecode`), mobile
 * application graph React Native bundle projection, and APK follow-up probes.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { requireMcpOutput } from "./lib/mcp-verifier-results.mjs";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = resolve(root, "scripts/rea.mjs");

const crcTable = Array.from({ length: 256 }, (_u, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1)
    value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

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
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02_01_4b_50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
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

function createHermesV90Fixture() {
  const s0 = Buffer.from("authenticateBiometric", "latin1");
  const s1 = Buffer.from("Ask biometric authentication", "latin1");
  const s2 = Buffer.from("A".repeat(260), "latin1"); // overflow string (>254 chars)
  const stringStorage = Buffer.concat([s0, s1, s2]);
  const pad4 = (len) => (len % 4 === 0 ? 0 : 4 - (len % 4));
  const storagePad = Buffer.alloc(pad4(stringStorage.length));
  const bytecode = Buffer.from([0x24, 0x00, 0x32, 0x00]);

  // 128 header + 16 fn + 8 kinds + 4 idHash + 12 smallStrings + 8 overflowString + storage + pad + 4 bc + 20 footer
  const fnOffset =
    128 + 16 + 8 + 4 + 12 + 8 + stringStorage.length + storagePad.length;
  const totalBytes = fnOffset + bytecode.length + 20;
  const buf = Buffer.alloc(totalBytes);

  buf.writeBigUInt64LE(0x1f1903c103bc1fc6n, 0);
  buf.writeUInt32LE(90, 8);
  createHash("sha1").update("hermes-fixture-src").digest().copy(buf, 12);
  buf.writeUInt32LE(totalBytes, 32);
  buf.writeUInt32LE(0, 36);
  buf.writeUInt32LE(1, 40); // functionCount = 1
  buf.writeUInt32LE(2, 44); // stringKindCount = 2
  buf.writeUInt32LE(1, 48); // identifierCount = 1
  buf.writeUInt32LE(3, 52); // stringCount = 3
  buf.writeUInt32LE(1, 56); // overflowStringCount = 1
  buf.writeUInt32LE(stringStorage.length, 60);
  buf.writeUInt32LE(2, 72); // regExpCount = 2
  buf.writeUInt32LE(5, 96); // cjsModuleCount = 5
  buf.writeUInt8(0x05, 108); // staticBuiltins + hasAsync

  // SmallFuncHeader[0]: offset=fnOffset, paramCount=2, bytecodeSize=4, functionName=0, frameSize=3, strictMode=true
  buf.writeUInt32LE((fnOffset & 0x1ffffff) | ((2 & 0x7f) << 25), 128);
  buf.writeUInt32LE((bytecode.length & 0x7fff) | ((0 & 0x1ffff) << 15), 132);
  buf.writeUInt32LE((0 & 0x1ffffff) | ((3 & 0x7f) << 25), 136);
  buf.writeUInt8(0x02 | (1 << 2), 143); // ProhibitNone + strictMode

  // StringKinds: 1 identifier, 2 strings
  buf.writeUInt32LE(0x80000001, 144);
  buf.writeUInt32LE(0x00000002, 148);
  buf.writeUInt32LE(0xdeadbeef, 152);

  // SmallStringTable (156..168)
  buf.writeUInt32LE(
    (((0 & 0x7fffff) << 1) | ((s0.length & 0xff) << 24)) >>> 0,
    156,
  );
  buf.writeUInt32LE(
    (((s0.length & 0x7fffff) << 1) | ((s1.length & 0xff) << 24)) >>> 0,
    160,
  );
  // Overflowed entry: length == 0xff, offset == overflow index 0
  buf.writeUInt32LE((((0 & 0x7fffff) << 1) | (0xff << 24)) >>> 0, 164);

  // OverflowStringTable at 168..176
  buf.writeUInt32LE(s0.length + s1.length, 168);
  buf.writeUInt32LE(s2.length, 172);

  // StringStorage at 176
  stringStorage.copy(buf, 176);
  bytecode.copy(buf, fnOffset);

  createHash("sha1")
    .update(buf.subarray(0, totalBytes - 20))
    .digest()
    .copy(buf, totalBytes - 20);
  return buf;
}

const optionalApkIdx = process.argv.indexOf("--apk");
const optionalApk =
  optionalApkIdx >= 0 ? resolve(process.argv[optionalApkIdx + 1]) : null;

const workspace = await mkdtemp(join(tmpdir(), "rea-verify-hermes-"));
try {
  const hbcBytes = createHermesV90Fixture();
  const hbcFile = join(workspace, "index.android.bundle");
  const apkFile = join(workspace, "rn-sample.apk");
  const plainApkFile = join(workspace, "plain-js.apk");
  const plainJsFile = join(workspace, "bundle.js");

  await writeFile(hbcFile, hbcBytes);
  await writeFile(
    apkFile,
    storedZip([
      {
        name: "AndroidManifest.xml",
        data: Buffer.from([0x03, 0x00, 0x08, 0x00, 0x08, 0x00, 0x00, 0x00]),
      },
      {
        name: "classes.dex",
        data: Buffer.from("dex\n035\0" + "0".repeat(32), "latin1"),
      },
      { name: "assets/index.android.bundle", data: hbcBytes },
    ]),
  );
  await writeFile(
    plainApkFile,
    storedZip([
      {
        name: "AndroidManifest.xml",
        data: Buffer.from([0x03, 0x00, 0x08, 0x00, 0x08, 0x00, 0x00, 0x00]),
      },
      {
        name: "assets/index.android.bundle",
        data: Buffer.from(
          "__d(function(g,r,i,a,m,e,d){console.log('plain');},0,[]);",
          "utf8",
        ),
      },
    ]),
  );
  await writeFile(plainJsFile, "const x = 1;\n", "utf8");

  // 1. CLI APK Hermes inspection + overflow string + footer SHA-1
  const { stdout: cliOut } = await execute(
    process.execPath,
    [entrypoint, "inspect-hermes-bytecode", apkFile, "--format", "json"],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 },
  );
  const cliEv = JSON.parse(cliOut);
  assert.equal(cliEv.operation, "inspect_hermes_bytecode");
  const res = cliEv.normalized_result;
  assert.equal(res.hermes_detected, true);
  assert.equal(res.coverage, "complete");
  assert.equal(res.selected_bundle.entry_path, "assets/index.android.bundle");
  assert.equal(res.selected_bundle.header.version, 90);
  assert.equal(res.selected_bundle.footer_sha1.matches, true);
  assert.equal(res.selected_bundle.strings.length, 3);
  assert.equal(res.selected_bundle.strings[0].kind, "identifier");
  assert.equal(res.selected_bundle.strings[0].value, "authenticateBiometric");
  assert.equal(res.selected_bundle.strings[2].overflowed, true);
  assert.equal(res.selected_bundle.strings[2].length, 260);
  assert.equal(
    res.selected_bundle.functions[0].name,
    "authenticateBiometric",
  );
  assert.equal(res.selected_bundle.functions[0].strict_mode, true);

  // 2. CLI inspect-artifact + project-android-application-graph on React Native APK
  const { stdout: inspOut } = await execute(
    process.execPath,
    [entrypoint, "inspect-artifact", apkFile, "--format", "json"],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 },
  );
  const inspEv = JSON.parse(inspOut);
  const probeOps = inspEv.normalized_result.next_probes.map((p) => p.operation);
  assert.ok(probeOps.includes("project_android_application_graph"));
  assert.ok(probeOps.includes("inspect_hermes_bytecode"));

  // 3. Standalone .bundle inspection with query filter
  const { stdout: standaloneOut } = await execute(
    process.execPath,
    [
      entrypoint,
      "inspect-hermes-bytecode",
      hbcFile,
      "--query",
      "biometric",
      "--format",
      "json",
    ],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 },
  );
  const standaloneRes = JSON.parse(standaloneOut).normalized_result;
  assert.equal(standaloneRes.target.target_kind, "bytecode-file");
  assert.equal(standaloneRes.selected_bundle.selection.returned_strings, 2);
  assert.equal(standaloneRes.selected_bundle.selection.returned_functions, 1);

  // 4. Plain UTF-8 JS bundle inside APK -> hermes_detected: false + plain_javascript_bundles
  const { stdout: plainApkOut } = await execute(
    process.execPath,
    [entrypoint, "inspect-hermes-bytecode", plainApkFile, "--format", "json"],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 },
  );
  const plainApkRes = JSON.parse(plainApkOut).normalized_result;
  assert.equal(plainApkRes.hermes_detected, false);
  assert.deepEqual(plainApkRes.plain_javascript_bundles, [
    "assets/index.android.bundle",
  ]);

  // 5. MCP stdio parity + project_android_application_graph check
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    cwd: root,
    env: process.env,
    stderr: "pipe",
  });
  const client = new Client({ name: "verify-hermes", version: "1.0.0" });
  await client.connect(transport);
  try {
    const mcpHermes = requireMcpOutput(
      await client.callTool({
        name: "inspect_hermes_bytecode",
        arguments: { path: apkFile },
      }),
      "inspect_hermes_bytecode",
    );
    assert.deepEqual(mcpHermes.normalized_result, res);

    const invEv = inspEv.normalized_result.substeps[0].evidence;
    const mcpGraph = requireMcpOutput(
      await client.callTool({
        name: "project_android_application_graph",
        arguments: { inventory_evidence: [invEv] },
      }),
      "project_android_application_graph",
    );
    const graphRes = mcpGraph.normalized_result;
    assert.deepEqual(
      graphRes.components.javascript.map((c) => c.path),
      ["assets/index.android.bundle"],
    );
    assert.ok(graphRes.runtime_families.includes("javascript"));
    assert.ok(graphRes.runtime_families.includes("react-native"));

    if (optionalApk !== null) {
      const realHermes = requireMcpOutput(
        await client.callTool({
          name: "inspect_hermes_bytecode",
          arguments: { path: optionalApk, query: "biometric", limit: 20 },
        }),
        "inspect_hermes_bytecode",
      );
      assert.equal(realHermes.normalized_result.hermes_detected, true);
      assert.equal(
        realHermes.normalized_result.selected_bundle.footer_sha1.matches,
        true,
      );
      console.log(
        `PASS real APK Hermes verification (${optionalApk}): version=${realHermes.normalized_result.selected_bundle.header.version}, strings=${realHermes.normalized_result.selected_bundle.header.string_count}, functions=${realHermes.normalized_result.selected_bundle.header.function_count}`,
      );
    }
  } finally {
    await client.close();
    await transport.close();
  }

  console.log("PASS verify-hermes-bytecode (CLI + MCP + Android graph parity)");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
