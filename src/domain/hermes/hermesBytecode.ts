import { createHash } from "node:crypto";
import { z } from "zod";
import { digestSchema } from "../digests.js";
import { createEvidence, type Evidence } from "../evidence.js";
import { localPathStringSchema } from "../localPath.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";

/** Identity of REA's pure-TypeScript Hermes bytecode inspector. */
export const HERMES_BYTECODE_PROVIDER_IDENTITY = {
  id: "hermes-bytecode",
  name: "REA Hermes bytecode reader",
  version: null,
} as const;

/** Resource bounds for in-process Hermes bytecode and APK bundle inspection. */
export const HERMES_BYTECODE_LIMITS = {
  apkBytes: 512 * 1024 * 1024,
  apkMetadataReadBytes: 8 * 1024 * 1024,
  bundleBytes: 128 * 1024 * 1024,
  totalCandidateScanBytes: 256 * 1024 * 1024,
  maxPageLimit: 500,
  defaultPageLimit: 100,
  maxQueryCharacters: 512,
  maxEntryPathCharacters: 1024,
} as const;

/** Little-endian 64-bit magic of execution-form Hermes bytecode ("Hermes" in Greek UTF-16BE). */
export const HERMES_EXECUTION_MAGIC = 0x1f1903c103bc1fc6n;
/** Little-endian 64-bit magic of delta-form Hermes bytecode (~HERMES_EXECUTION_MAGIC). */
export const HERMES_DELTA_MAGIC = 0xe0e6fc3efc43e039n;
/** Fixed header size across Hermes bytecode versions (128 bytes). */
export const HERMES_HEADER_BYTES = 128;

const sha1DigestSchema = z.string().regex(/^[0-9a-f]{40}$/u);

export const hermesStringKindFilterSchema = z.enum([
  "all",
  "identifier",
  "string",
]);

export const inspectHermesBytecodeInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Local Hermes bytecode file (.hbc, .bundle, .jsbundle) or Android APK archive",
  ),
  entry_path: z
    .string()
    .min(1)
    .max(HERMES_BYTECODE_LIMITS.maxEntryPathCharacters)
    .optional()
    .describe(
      "Exact archive member path to inspect when path is an APK/ZIP container (defaults to assets/index.android.bundle, then canonical path order)",
    ),
  query: z
    .string()
    .min(1)
    .max(HERMES_BYTECODE_LIMITS.maxQueryCharacters)
    .optional()
    .describe(
      "Case-insensitive substring filter applied to decoded string-table entries and named function headers",
    ),
  string_kind: hermesStringKindFilterSchema
    .optional()
    .describe(
      "Restrict returned string-table rows to identifiers, non-identifier literals, or all entries (default: all)",
    ),
  offset: z
    .int()
    .nonnegative()
    .optional()
    .describe("Zero-based pagination offset into matching string/function rows"),
  limit: z
    .int()
    .min(1)
    .max(HERMES_BYTECODE_LIMITS.maxPageLimit)
    .optional()
    .describe(
      `Maximum matching strings and functions to return per page (default ${String(HERMES_BYTECODE_LIMITS.defaultPageLimit)}, max ${String(HERMES_BYTECODE_LIMITS.maxPageLimit)})`,
    ),
});

export type InspectHermesBytecodeInput = z.infer<
  typeof inspectHermesBytecodeInputSchema
>;

export const hermesBundleSummarySchema = z.strictObject({
  entry_path: z.string().min(1).nullable(),
  bytes: z.int().nonnegative(),
  sha256: digestSchema,
  bytecode_form: z.enum(["execution", "delta"]),
  version: z.int().nonnegative(),
  source_hash_sha1: sha1DigestSchema,
  function_count: z.int().nonnegative(),
  string_count: z.int().nonnegative(),
  identifier_count: z.int().nonnegative(),
});

export const hermesStringEntrySchema = z.strictObject({
  string_id: z.int().nonnegative(),
  kind: z.enum(["identifier", "string", "unknown"]),
  encoding: z.enum(["ascii", "utf-16le"]),
  length: z.int().nonnegative(),
  overflowed: z.boolean(),
  value: z.string(),
});

export const hermesFunctionEntrySchema = z.strictObject({
  function_id: z.int().nonnegative(),
  name_string_id: z.int().nonnegative().nullable(),
  name: z.string().nullable(),
  bytecode_offset: z.int().nonnegative(),
  bytecode_bytes: z.int().nonnegative(),
  param_count: z.int().nonnegative(),
  frame_size: z.int().nonnegative(),
  environment_size: z.int().nonnegative(),
  strict_mode: z.boolean(),
  has_exception_handler: z.boolean(),
  has_debug_info: z.boolean(),
  overflowed: z.boolean(),
});

export const hermesDecodedBundleSchema = z.strictObject({
  entry_path: z.string().min(1).nullable(),
  bytes: z.int().nonnegative(),
  sha256: digestSchema,
  header: z.strictObject({
    magic_hex: z.string().regex(/^0x[0-9a-f]{16}$/u),
    bytecode_form: z.enum(["execution", "delta"]),
    version: z.int().nonnegative(),
    header_layout_profile: z.enum([
      "v78-v83",
      "v84-v86",
      "v87-v96",
      "invariant-prefix-only",
    ]),
    source_hash_sha1: sha1DigestSchema,
    declared_file_length: z.int().nonnegative(),
    global_code_index: z.int().nonnegative(),
    function_count: z.int().nonnegative(),
    string_kind_count: z.int().nonnegative(),
    identifier_count: z.int().nonnegative(),
    string_count: z.int().nonnegative(),
    overflow_string_count: z.int().nonnegative(),
    string_storage_bytes: z.int().nonnegative(),
    big_int_count: z.int().nonnegative().nullable(),
    big_int_storage_bytes: z.int().nonnegative().nullable(),
    reg_exp_count: z.int().nonnegative().nullable(),
    reg_exp_storage_bytes: z.int().nonnegative().nullable(),
    array_buffer_bytes: z.int().nonnegative().nullable(),
    obj_key_buffer_bytes: z.int().nonnegative().nullable(),
    obj_value_buffer_bytes: z.int().nonnegative().nullable(),
    segment_id: z.int().nonnegative().nullable(),
    cjs_module_count: z.int().nonnegative().nullable(),
    function_source_count: z.int().nonnegative().nullable(),
    debug_info_offset: z.int().nonnegative().nullable(),
    options: z
      .strictObject({
        raw_flags: z.int().nonnegative(),
        static_builtins: z.boolean(),
        cjs_modules_statically_resolved: z.boolean(),
        has_async: z.boolean(),
      })
      .nullable(),
  }),
  footer_sha1: z
    .strictObject({
      declared: sha1DigestSchema,
      computed: sha1DigestSchema,
      matches: z.boolean(),
    })
    .nullable(),
  table_coverage: z.strictObject({
    string_kinds_complete: z.boolean(),
    string_table_complete: z.boolean(),
    function_headers_supported: z.boolean(),
    function_headers_complete: z.boolean(),
    decoded_strings: z.int().nonnegative(),
    decoded_functions: z.int().nonnegative(),
    named_functions: z.int().nonnegative(),
    overflow_functions: z.int().nonnegative(),
  }),
  selection: z.strictObject({
    query: z.string().nullable(),
    string_kind: hermesStringKindFilterSchema,
    offset: z.int().nonnegative(),
    limit: z.int().positive(),
    total_matching_strings: z.int().nonnegative(),
    returned_strings: z.int().nonnegative(),
    total_matching_functions: z.int().nonnegative(),
    returned_functions: z.int().nonnegative(),
  }),
  strings: z.array(hermesStringEntrySchema),
  functions: z.array(hermesFunctionEntrySchema),
});

export const hermesBytecodeResultSchema = z.strictObject({
  target: z.strictObject({
    selected_path: localPathStringSchema,
    resolved_path: localPathStringSchema,
    bytes: z.int().nonnegative(),
    sha256: digestSchema,
    target_kind: z.enum(["apk-container", "bytecode-file"]),
  }),
  hermes_detected: z.boolean(),
  bundles: z.array(hermesBundleSummarySchema),
  plain_javascript_bundles: z.array(z.string().min(1)),
  selected_bundle: hermesDecodedBundleSchema.nullable(),
  coverage: z.enum(["complete", "partial"]),
  limitations: z.array(z.string().min(1)),
});

export type HermesBytecodeResult = z.infer<typeof hermesBytecodeResultSchema>;
export type HermesBundleSummary = z.infer<typeof hermesBundleSummarySchema>;
export type HermesDecodedBundle = z.infer<typeof hermesDecodedBundleSchema>;

/** Recognize execution-form or delta-form Hermes magic in the first 8 bytes. */
export const detectHermesMagic = (
  prefix: Uint8Array,
): "execution" | "delta" | null => {
  if (prefix.byteLength < 8) return null;
  const view = new DataView(
    prefix.buffer,
    prefix.byteOffset,
    prefix.byteLength,
  );
  const magic = view.getBigUint64(0, true);
  if (magic === HERMES_EXECUTION_MAGIC) return "execution";
  if (magic === HERMES_DELTA_MAGIC) return "delta";
  return null;
};

/** Heuristic check for non-Hermes UTF-8 JS bundles inside an APK's assets/. */
export const looksLikeUtf8JavaScriptText = (prefix: Uint8Array): boolean => {
  if (prefix.byteLength === 0 || detectHermesMagic(prefix) !== null)
    return false;
  const sample = prefix.subarray(0, Math.min(prefix.byteLength, 512));
  for (const byte of sample) {
    if (byte === 0) return false;
  }
  const text = Buffer.from(sample).toString("utf8").trimStart();
  return (
    text.startsWith("var ") ||
    text.startsWith("__d(") ||
    text.startsWith("(function") ||
    text.startsWith("!function") ||
    text.startsWith("\"use strict\"") ||
    text.startsWith("'use strict'") ||
    text.startsWith("//") ||
    text.startsWith("/*")
  );
};

const align4 = (offset: number): number => {
  const remainder = offset % 4;
  return remainder === 0 ? offset : offset + (4 - remainder);
};

const parseOptionsByte = (rawFlags: number) => ({
  raw_flags: rawFlags,
  static_builtins: (rawFlags & 0x01) !== 0,
  cjs_modules_statically_resolved: (rawFlags & 0x02) !== 0,
  has_async: (rawFlags & 0x04) !== 0,
});

export interface HermesParseSelection {
  readonly entryPath: string | null;
  readonly sha256: string;
  readonly query?: string | undefined;
  readonly stringKind?: z.infer<typeof hermesStringKindFilterSchema> | undefined;
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
}

/** Parse one validated Hermes header summary without decoding full tables. */
export const summarizeHermesBytecodeBuffer = (
  buffer: Buffer,
  entryPath: string | null,
  sha256: string,
): HermesBundleSummary | null => {
  if (buffer.byteLength < HERMES_HEADER_BYTES) return null;
  const form = detectHermesMagic(buffer);
  if (form === null) return null;
  return {
    entry_path: entryPath,
    bytes: buffer.byteLength,
    sha256,
    bytecode_form: form,
    version: buffer.readUInt32LE(8),
    source_hash_sha1: buffer.subarray(12, 32).toString("hex"),
    function_count: buffer.readUInt32LE(40),
    identifier_count: buffer.readUInt32LE(48),
    string_count: buffer.readUInt32LE(52),
  };
};

/**
 * Pure, execution-free parser for a Hermes bytecode buffer (.hbc / .bundle).
 * Validates every table span before reading and reports explicit partial
 * coverage if truncated or from an unknown future header revision.
 */
export const parseHermesBytecodeBuffer = (
  buffer: Buffer,
  selection: HermesParseSelection,
):
  | {
      readonly ok: true;
      readonly bundle: HermesDecodedBundle;
      readonly summary: HermesBundleSummary;
      readonly limitations: readonly string[];
      readonly complete: boolean;
    }
  | { readonly ok: false; readonly message: string } => {
  const form = detectHermesMagic(buffer);
  if (form === null) {
    return {
      ok: false,
      message:
        "Buffer does not start with Hermes bytecode magic (0x1f1903c103bc1fc6).",
    };
  }
  if (buffer.byteLength < HERMES_HEADER_BYTES) {
    return {
      ok: false,
      message: `Hermes bytecode image is truncated (${String(buffer.byteLength)} bytes < ${String(HERMES_HEADER_BYTES)}-byte BytecodeFileHeader).`,
    };
  }

  const magicHex = `0x${buffer.readBigUInt64LE(0).toString(16).padStart(16, "0")}`;
  const version = buffer.readUInt32LE(8);
  const sourceHashSha1 = buffer.subarray(12, 32).toString("hex");
  const declaredFileLength = buffer.readUInt32LE(32);
  const globalCodeIndex = buffer.readUInt32LE(36);
  const functionCount = buffer.readUInt32LE(40);
  const stringKindCount = buffer.readUInt32LE(44);
  const identifierCount = buffer.readUInt32LE(48);
  const stringCount = buffer.readUInt32LE(52);
  const overflowStringCount = buffer.readUInt32LE(56);
  const stringStorageBytes = buffer.readUInt32LE(60);

  const limitations: string[] = [];
  let headerLayoutProfile: HermesDecodedBundle["header"]["header_layout_profile"] =
    "invariant-prefix-only";
  let bigIntCount: number | null = null;
  let bigIntStorageBytes: number | null = null;
  let regExpCount: number | null = null;
  let regExpStorageBytes: number | null = null;
  let arrayBufferBytes: number | null = null;
  let objKeyBufferBytes: number | null = null;
  let objValueBufferBytes: number | null = null;
  let segmentId: number | null = null;
  let cjsModuleCount: number | null = null;
  let functionSourceCount: number | null = null;
  let debugInfoOffset: number | null = null;
  let options: HermesDecodedBundle["header"]["options"] = null;

  if (version >= 87 && version <= 96) {
    headerLayoutProfile = "v87-v96";
    bigIntCount = buffer.readUInt32LE(64);
    bigIntStorageBytes = buffer.readUInt32LE(68);
    regExpCount = buffer.readUInt32LE(72);
    regExpStorageBytes = buffer.readUInt32LE(76);
    arrayBufferBytes = buffer.readUInt32LE(80);
    objKeyBufferBytes = buffer.readUInt32LE(84);
    objValueBufferBytes = buffer.readUInt32LE(88);
    segmentId = buffer.readUInt32LE(92);
    cjsModuleCount = buffer.readUInt32LE(96);
    functionSourceCount = buffer.readUInt32LE(100);
    debugInfoOffset = buffer.readUInt32LE(104);
    options = parseOptionsByte(buffer.readUInt8(108));
  } else if (version >= 84 && version <= 86) {
    headerLayoutProfile = "v84-v86";
    regExpCount = buffer.readUInt32LE(64);
    regExpStorageBytes = buffer.readUInt32LE(68);
    arrayBufferBytes = buffer.readUInt32LE(72);
    objKeyBufferBytes = buffer.readUInt32LE(76);
    objValueBufferBytes = buffer.readUInt32LE(80);
    segmentId = buffer.readUInt32LE(84);
    cjsModuleCount = buffer.readUInt32LE(88);
    functionSourceCount = buffer.readUInt32LE(92);
    debugInfoOffset = buffer.readUInt32LE(96);
    options = parseOptionsByte(buffer.readUInt8(100));
  } else if (version >= 78 && version <= 83) {
    headerLayoutProfile = "v78-v83";
    regExpCount = buffer.readUInt32LE(64);
    regExpStorageBytes = buffer.readUInt32LE(68);
    arrayBufferBytes = buffer.readUInt32LE(72);
    objKeyBufferBytes = buffer.readUInt32LE(76);
    objValueBufferBytes = buffer.readUInt32LE(80);
    segmentId = buffer.readUInt32LE(84);
    cjsModuleCount = buffer.readUInt32LE(88);
    debugInfoOffset = buffer.readUInt32LE(92);
    options = parseOptionsByte(buffer.readUInt8(96));
  } else {
    limitations.push(
      `Hermes bytecode version ${String(version)} is outside exact tail-header profiles (v78-v96); invariant header fields and string tables are decoded, while version-specific tail header fields remain null.`,
    );
  }

  let footerSha1: HermesDecodedBundle["footer_sha1"] = null;
  let footerValid = true;
  if (declaredFileLength !== buffer.byteLength) {
    footerValid = false;
    limitations.push(
      `Declared fileLength (${String(declaredFileLength)}) differs from observed bundle size (${String(buffer.byteLength)} bytes).`,
    );
  }
  if (
    version >= 76 &&
    declaredFileLength >= HERMES_HEADER_BYTES + 20 &&
    declaredFileLength <= buffer.byteLength
  ) {
    const bodyEnd = declaredFileLength - 20;
    const declared = buffer
      .subarray(bodyEnd, declaredFileLength)
      .toString("hex");
    const computed = createHash("sha1")
      .update(buffer.subarray(0, bodyEnd))
      .digest("hex");
    const matches = declared === computed;
    footerSha1 = { declared, computed, matches };
    if (!matches) {
      footerValid = false;
      limitations.push(
        "BytecodeFileFooter SHA-1 does not match the preceding bytecode bytes; the bundle may be modified or corrupted.",
      );
    }
  }

  // Segment offsets following visitBytecodeSegmentsInOrder:
  // 1. functionHeaders (functionCount * 16)
  // 2. stringKinds (stringKindCount * 4)
  // 3. identifierHashes (identifierCount * 4)
  // 4. smallStringTable (stringCount * 4)
  // 5. overflowStringTable (overflowStringCount * 8)
  // 6. stringStorage (stringStorageBytes)
  const fnTableOffset = HERMES_HEADER_BYTES;
  const fnTableBytes = functionCount * 16;
  const stringKindsOffset = align4(fnTableOffset + fnTableBytes);
  const stringKindsBytes = stringKindCount * 4;
  const idHashesOffset = align4(stringKindsOffset + stringKindsBytes);
  const idHashesBytes = identifierCount * 4;
  const smallStringsOffset = align4(idHashesOffset + idHashesBytes);
  const smallStringsBytes = stringCount * 4;
  const overflowStringsOffset = align4(smallStringsOffset + smallStringsBytes);
  const overflowStringsBytes = overflowStringCount * 8;
  const stringStorageOffset = align4(
    overflowStringsOffset + overflowStringsBytes,
  );
  const stringStorageEnd = stringStorageOffset + stringStorageBytes;

  // Decode run-length encoded StringKind entries when within bounds.
  const kinds: ("identifier" | "string")[] = [];
  let stringKindsComplete = false;
  if (
    stringKindsOffset >= 0 &&
    stringKindsOffset + stringKindsBytes <= buffer.byteLength
  ) {
    let validRle = true;
    for (let index = 0; index < stringKindCount; index += 1) {
      const datum = buffer.readUInt32LE(stringKindsOffset + index * 4);
      const isIdentifier = (datum >>> 31) === 1;
      const runLength = datum & 0x7fffffff;
      if (kinds.length + runLength > stringCount) {
        validRle = false;
        break;
      }
      const label = isIdentifier ? "identifier" : "string";
      for (let step = 0; step < runLength; step += 1) kinds.push(label);
    }
    stringKindsComplete = validRle && kinds.length === stringCount;
    if (!stringKindsComplete) {
      limitations.push(
        "StringKind run-length table did not sum to stringCount; unattributed entries report kind 'unknown'.",
      );
    }
  } else {
    limitations.push(
      "StringKind table extends past buffer bounds; string kinds could not be decoded.",
    );
  }

  // Decode SmallStringTableEntry + OverflowStringTableEntry + stringStorage.
  const allStrings: z.infer<typeof hermesStringEntrySchema>[] = [];
  let stringTableComplete = false;
  if (
    smallStringsOffset >= 0 &&
    smallStringsOffset + smallStringsBytes <= buffer.byteLength &&
    overflowStringsOffset + overflowStringsBytes <= buffer.byteLength &&
    stringStorageEnd <= buffer.byteLength
  ) {
    let allEntriesValid = true;
    for (let stringId = 0; stringId < stringCount; stringId += 1) {
      const packed = buffer.readUInt32LE(smallStringsOffset + stringId * 4);
      const isUtf16 = (packed & 1) === 1;
      let charOffset = (packed >>> 1) & 0x7fffff;
      let charLength = (packed >>> 24) & 0xff;
      const overflowed = charLength === 0xff;
      if (overflowed) {
        if (charOffset >= overflowStringCount) {
          allEntriesValid = false;
          break;
        }
        const overflowEntryOffset = overflowStringsOffset + charOffset * 8;
        charOffset = buffer.readUInt32LE(overflowEntryOffset);
        charLength = buffer.readUInt32LE(overflowEntryOffset + 4);
      }
      const byteSpan = isUtf16 ? charLength * 2 : charLength;
      const sliceStart = stringStorageOffset + charOffset;
      const sliceEnd = sliceStart + byteSpan;
      if (
        !Number.isSafeInteger(sliceEnd) ||
        sliceStart < stringStorageOffset ||
        sliceEnd > stringStorageEnd
      ) {
        allEntriesValid = false;
        break;
      }
      const rawBytes = buffer.subarray(sliceStart, sliceEnd);
      const value = isUtf16
        ? rawBytes.toString("utf16le")
        : rawBytes.toString("latin1");
      allStrings.push({
        string_id: stringId,
        kind: kinds[stringId] ?? "unknown",
        encoding: isUtf16 ? "utf-16le" : "ascii",
        length: charLength,
        overflowed,
        value,
      });
    }
    stringTableComplete = allEntriesValid && allStrings.length === stringCount;
    if (!stringTableComplete) {
      limitations.push(
        `String table stopped at entry ${String(allStrings.length)} of ${String(stringCount)} due to an out-of-range offset or overflow index.`,
      );
    }
  } else {
    limitations.push(
      "String table or string storage extends past buffer bounds; strings could not be decoded.",
    );
  }

  // Decode SmallFuncHeader + overflow FunctionHeader for supported bitfield layout (v59-v96).
  const functionHeadersSupported =
    form === "execution" && version >= 59 && version <= 96;
  let functionHeadersComplete = false;
  let namedFunctions = 0;
  let overflowFunctions = 0;
  const allFunctions: z.infer<typeof hermesFunctionEntrySchema>[] = [];

  if (!functionHeadersSupported) {
    limitations.push(
      form === "delta"
        ? "Delta-form Hermes bytecode is optimized for binary diffing rather than execution; function headers are not decoded."
        : `Function header bitfield layout is only decoded for Hermes execution versions 59-96 (observed version ${String(version)}).`,
    );
  } else if (fnTableOffset + fnTableBytes > buffer.byteLength) {
    limitations.push(
      "Function header table extends past buffer bounds; functions could not be decoded.",
    );
  } else {
    let validFunctions = true;
    for (let fnId = 0; fnId < functionCount; fnId += 1) {
      const base = fnTableOffset + fnId * 16;
      const word0 = buffer.readUInt32LE(base);
      const word1 = buffer.readUInt32LE(base + 4);
      const word2 = buffer.readUInt32LE(base + 8);
      const envSmall = buffer.readUInt8(base + 12);
      const flags = buffer.readUInt8(base + 15);
      const overflowed = ((flags >>> 5) & 1) === 1;

      let bytecodeOffset: number;
      let paramCount: number;
      let bytecodeBytes: number;
      let nameId: number;
      let frameSize: number;
      let environmentSize: number;
      let effectiveFlags = flags;

      if (overflowed) {
        overflowFunctions += 1;
        const smallOffset = word0 & 0x1ffffff;
        const smallInfoOffset = word2 & 0x1ffffff;
        const largeHeaderOffset = smallInfoOffset * 0x10000 + (smallOffset & 0xffff);
        if (
          !Number.isSafeInteger(largeHeaderOffset) ||
          largeHeaderOffset < 0 ||
          largeHeaderOffset + 32 > buffer.byteLength
        ) {
          validFunctions = false;
          break;
        }
        bytecodeOffset = buffer.readUInt32LE(largeHeaderOffset);
        paramCount = buffer.readUInt32LE(largeHeaderOffset + 4);
        bytecodeBytes = buffer.readUInt32LE(largeHeaderOffset + 8);
        nameId = buffer.readUInt32LE(largeHeaderOffset + 12);
        frameSize = buffer.readUInt32LE(largeHeaderOffset + 20);
        environmentSize = buffer.readUInt32LE(largeHeaderOffset + 24);
        effectiveFlags = buffer.readUInt8(largeHeaderOffset + 31);
      } else {
        bytecodeOffset = word0 & 0x1ffffff;
        paramCount = (word0 >>> 25) & 0x7f;
        bytecodeBytes = word1 & 0x7fff;
        nameId = (word1 >>> 15) & 0x1ffff;
        frameSize = (word2 >>> 25) & 0x7f;
        environmentSize = envSmall;
      }

      const resolvedName =
        nameId < allStrings.length ? (allStrings[nameId]?.value ?? null) : null;
      if (resolvedName !== null && resolvedName.length > 0) namedFunctions += 1;

      allFunctions.push({
        function_id: fnId,
        name_string_id: nameId < stringCount ? nameId : null,
        name: resolvedName,
        bytecode_offset: bytecodeOffset,
        bytecode_bytes: bytecodeBytes,
        param_count: paramCount,
        frame_size: frameSize,
        environment_size: environmentSize,
        strict_mode: ((effectiveFlags >>> 2) & 1) === 1,
        has_exception_handler: ((effectiveFlags >>> 3) & 1) === 1,
        has_debug_info: ((effectiveFlags >>> 4) & 1) === 1,
        overflowed,
      });
    }
    functionHeadersComplete =
      validFunctions && allFunctions.length === functionCount;
    if (!functionHeadersComplete) {
      limitations.push(
        `Function header decoding stopped at function ${String(allFunctions.length)} of ${String(functionCount)} due to an out-of-bounds overflow FunctionHeader.`,
      );
    }
  }

  const normalizedQuery =
    selection.query === undefined
      ? null
      : selection.query.toLocaleLowerCase("en-US");
  const stringKindFilter = selection.stringKind ?? "all";
  const offset = selection.offset ?? 0;
  const limit = selection.limit ?? HERMES_BYTECODE_LIMITS.defaultPageLimit;

  const matchingStrings = allStrings.filter((entry) => {
    if (stringKindFilter !== "all" && entry.kind !== stringKindFilter)
      return false;
    if (normalizedQuery === null) return true;
    return entry.value.toLocaleLowerCase("en-US").includes(normalizedQuery);
  });

  const matchingFunctions = allFunctions.filter((entry) => {
    if (normalizedQuery === null) return true;
    return (
      entry.name !== null &&
      entry.name.toLocaleLowerCase("en-US").includes(normalizedQuery)
    );
  });

  const pagedStrings = matchingStrings.slice(offset, offset + limit);
  const pagedFunctions = matchingFunctions.slice(offset, offset + limit);

  const summary: HermesBundleSummary = {
    entry_path: selection.entryPath,
    bytes: buffer.byteLength,
    sha256: selection.sha256,
    bytecode_form: form,
    version,
    source_hash_sha1: sourceHashSha1,
    function_count: functionCount,
    string_count: stringCount,
    identifier_count: identifierCount,
  };

  const bundle: HermesDecodedBundle = {
    entry_path: selection.entryPath,
    bytes: buffer.byteLength,
    sha256: selection.sha256,
    header: {
      magic_hex: magicHex,
      bytecode_form: form,
      version,
      header_layout_profile: headerLayoutProfile,
      source_hash_sha1: sourceHashSha1,
      declared_file_length: declaredFileLength,
      global_code_index: globalCodeIndex,
      function_count: functionCount,
      string_kind_count: stringKindCount,
      identifier_count: identifierCount,
      string_count: stringCount,
      overflow_string_count: overflowStringCount,
      string_storage_bytes: stringStorageBytes,
      big_int_count: bigIntCount,
      big_int_storage_bytes: bigIntStorageBytes,
      reg_exp_count: regExpCount,
      reg_exp_storage_bytes: regExpStorageBytes,
      array_buffer_bytes: arrayBufferBytes,
      obj_key_buffer_bytes: objKeyBufferBytes,
      obj_value_buffer_bytes: objValueBufferBytes,
      segment_id: segmentId,
      cjs_module_count: cjsModuleCount,
      function_source_count: functionSourceCount,
      debug_info_offset: debugInfoOffset,
      options,
    },
    footer_sha1: footerSha1,
    table_coverage: {
      string_kinds_complete: stringKindsComplete,
      string_table_complete: stringTableComplete,
      function_headers_supported: functionHeadersSupported,
      function_headers_complete: functionHeadersComplete,
      decoded_strings: allStrings.length,
      decoded_functions: allFunctions.length,
      named_functions: namedFunctions,
      overflow_functions: overflowFunctions,
    },
    selection: {
      query: selection.query ?? null,
      string_kind: stringKindFilter,
      offset,
      limit,
      total_matching_strings: matchingStrings.length,
      returned_strings: pagedStrings.length,
      total_matching_functions: matchingFunctions.length,
      returned_functions: pagedFunctions.length,
    },
    strings: pagedStrings,
    functions: pagedFunctions,
  };

  const complete =
    headerLayoutProfile !== "invariant-prefix-only" &&
    footerValid &&
    stringKindsComplete &&
    stringTableComplete &&
    functionHeadersComplete;

  return { ok: true, bundle, summary, limitations, complete };
};

/** Select default primary bundle from discovered APK Hermes entries. */
export const selectDefaultHermesEntryPath = (
  entryPaths: readonly string[],
): string | undefined => {
  if (entryPaths.length === 0) return undefined;
  const preferred = entryPaths.find(
    (path) => path === "assets/index.android.bundle",
  );
  if (preferred !== undefined) return preferred;
  return [...entryPaths].sort(compareUnicodeCodePoints)[0];
};

/** Seal validated Hermes bytecode facts into artifact-bound Evidence. */
export const createHermesBytecodeEvidence = (
  input: InspectHermesBytecodeInput,
  result: HermesBytecodeResult,
  provider: Evidence["provider"],
): Evidence =>
  createEvidence(
    {
      path: result.target.resolved_path,
      sha256: result.target.sha256,
      format:
        result.target.target_kind === "apk-container" ? "apk" : "file",
    },
    provider,
    {
      operation: "inspect_hermes_bytecode",
      parameters: input,
      result,
      confidence: "observed",
      limitations: result.limitations,
      locations: [
        { kind: "artifact-path" as const, path: result.target.selected_path },
        ...(result.target.resolved_path === result.target.selected_path
          ? []
          : [
              {
                kind: "artifact-path" as const,
                path: result.target.resolved_path,
              },
            ]),
      ],
    },
  );
