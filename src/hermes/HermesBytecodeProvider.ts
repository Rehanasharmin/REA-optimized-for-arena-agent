import { createHash } from "node:crypto";
import { realpath, type FileHandle } from "node:fs/promises";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { HermesBytecodePort } from "../application/hermes/HermesBytecodePort.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
} from "../artifacts/ArtifactReader.js";
import { ZipArtifactReader } from "../artifacts/ZipArtifactReader.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import {
  detectHermesMagic,
  HERMES_BYTECODE_LIMITS,
  HERMES_BYTECODE_PROVIDER_IDENTITY,
  looksLikeUtf8JavaScriptText,
  parseHermesBytecodeBuffer,
  selectDefaultHermesEntryPath,
  summarizeHermesBytecodeBuffer,
  type HermesBundleSummary,
  type HermesBytecodeResult,
  type InspectHermesBytecodeInput,
} from "../domain/hermes/hermesBytecode.js";
import { isAndroidJavaScriptBundlePath } from "../domain/nativeConvention.js";
import { err, ok, type Result } from "../domain/result.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { regularFileCancellation } from "../filesystem/OwnedRegularFile.js";
import {
  assertStableRegularFileIdentity,
  NonRegularFileReadError,
  openRegularFile,
  RegularFileChangedError,
  type StableRegularFileDescriptor,
} from "../filesystem/RegularFile.js";

const OPERATION = "inspect_hermes_bytecode";
const DIGEST_CHUNK_BYTES = 1024 * 1024;

const hermesBudget = (allowance: string, kind: "parser" | "input") =>
  fixedAllowanceOptions(allowance, kind);

const isZipPrefix = (prefix: Uint8Array): boolean =>
  prefix.byteLength >= 4 &&
  prefix[0] === 0x50 &&
  prefix[1] === 0x4b &&
  ((prefix[2] === 0x03 && prefix[3] === 0x04) ||
    (prefix[2] === 0x05 && prefix[3] === 0x06) ||
    (prefix[2] === 0x07 && prefix[3] === 0x08));

const isCandidateApkBundleEntry = (entryPath: string): boolean =>
  isAndroidJavaScriptBundlePath(entryPath) ||
  /\.(?:bundle|jsbundle|hbc)$/iu.test(entryPath) ||
  /^assets\/[^/]+$/iu.test(entryPath);

const isCancellation = (cause: unknown): boolean =>
  cause instanceof AnalysisCancelledError ||
  (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled") ||
  (cause instanceof Error && cause.name === "AbortError") ||
  (typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ABORT_ERR");

const mapFailure = (path: string, cause: unknown): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  const fileCancelled = regularFileCancellation(cause);
  if (fileCancelled !== undefined)
    return new AnalysisCancelledError(OPERATION, {
      cause: fileCancelled.reason,
    });
  if (isCancellation(cause))
    return new AnalysisCancelledError(OPERATION, { cause });
  if (cause instanceof RegularFileChangedError)
    return new AnalysisArtifactChangedError(OPERATION, path, cause.message, {
      cause,
    });
  if (
    cause instanceof Error &&
    "code" in cause &&
    (cause.code === "EACCES" || cause.code === "EPERM")
  )
    return new AnalysisAccessDeniedError(OPERATION, path, cause.code, {
      cause,
    });
  if (cause instanceof ArtifactReaderFailure && cause.reason === "limit")
    return new AnalysisResourceConstraintError(
      OPERATION,
      "memory",
      cause.message,
      { max_metadata_read_bytes: HERMES_BYTECODE_LIMITS.apkMetadataReadBytes },
      {
        cause,
        ...hermesBudget("The Hermes APK metadata read allowance", "parser"),
      },
    );
  const message =
    cause instanceof Error &&
    "code" in cause &&
    (cause.code === "ENOENT" || cause.code === "ENOTDIR")
      ? `Selected target does not exist: ${path}`
      : cause instanceof NonRegularFileReadError
        ? `Selected target is not a regular file: ${path}`
        : `Could not read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`;
  return new AnalysisInputError(OPERATION, { cause, userMessage: message }, [
    {
      path: ["path"],
      reason: "invalid_format",
      message,
    },
  ]);
};

const readExactHandleRange = async (
  handle: FileHandle,
  length: number,
  position: number,
): Promise<Buffer> => {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      length - offset,
      position + offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === length ? buffer : buffer.subarray(0, offset);
};

const digestRegularFile = async (
  handle: FileHandle,
  totalBytes: number,
  signal: AbortSignal | undefined,
): Promise<string> => {
  const hash = createHash("sha256");
  const scratch = Buffer.allocUnsafe(
    Math.min(DIGEST_CHUNK_BYTES, Math.max(1, totalBytes)),
  );
  let position = 0;
  while (position < totalBytes) {
    if (signal?.aborted === true)
      throw new AnalysisCancelledError(OPERATION, { cause: signal.reason });
    const toRead = Math.min(scratch.byteLength, totalBytes - position);
    const { bytesRead } = await handle.read(scratch, 0, toRead, position);
    if (bytesRead === 0) break;
    hash.update(scratch.subarray(0, bytesRead));
    position += bytesRead;
    await yieldToEventLoop();
  }
  return hash.digest("hex");
};

const readZipEntryBounded = async (
  reader: ZipArtifactReader,
  entry: ArtifactEntry,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of await reader.open(entry, signal)) {
    total += chunk.byteLength;
    if (total > maxBytes)
      throw new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        `Archive member ${entry.path} exceeds the ${String(maxBytes)}-byte Hermes bundle budget`,
        { max_bundle_bytes: maxBytes, observed_bytes_at_least: total },
        hermesBudget("the Hermes bundle read allowance", "input"),
      );
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
};

/** Pure-TypeScript Hermes bytecode and APK bundle inspector. */
export class HermesBytecodeProvider implements HermesBytecodePort {
  readonly identity = HERMES_BYTECODE_PROVIDER_IDENTITY;

  async close(): Promise<void> {}

  async inspect(
    input: InspectHermesBytecodeInput,
    options?: ExecutionOptions,
  ): Promise<Result<HermesBytecodeResult, AnalysisError>> {
    const signal = options?.signal;
    if (signal?.aborted === true)
      return err(
        new AnalysisCancelledError(OPERATION, { cause: signal.reason }),
      );

    let admitted: StableRegularFileDescriptor | undefined;
    let handoffToZipReader = false;
    try {
      admitted = await openRegularFile(input.path, {
        symlinks: "follow",
        signal,
      });
      const resolvedPath = await realpath(input.path).catch(() => input.path);
      const fileBytes = admitted.initial.size;

      if (fileBytes > HERMES_BYTECODE_LIMITS.apkBytes) {
        return err(
          new AnalysisResourceConstraintError(
            OPERATION,
            "file-size",
            `Selected file (${String(fileBytes)} bytes) exceeds the ${String(HERMES_BYTECODE_LIMITS.apkBytes)}-byte target budget`,
            {
              max_target_bytes: HERMES_BYTECODE_LIMITS.apkBytes,
              observed_bytes: fileBytes,
            },
            hermesBudget("the Hermes target file allowance", "input"),
          ),
        );
      }

      const prefix = await readExactHandleRange(
        admitted.handle,
        Math.min(512, fileBytes),
        0,
      );

      if (detectHermesMagic(prefix) !== null) {
        if (input.entry_path !== undefined) {
          return err(
            new AnalysisInputError(
              OPERATION,
              {
                userMessage:
                  "entry_path applies only when path selects a ZIP/APK archive, not a standalone Hermes bytecode file.",
                conformsToInputContract: true,
              },
              [
                {
                  path: ["entry_path"],
                  reason: "invalid_value",
                  message:
                    "Omit entry_path when inspecting a standalone Hermes bytecode file.",
                },
              ],
            ),
          );
        }
        if (fileBytes > HERMES_BYTECODE_LIMITS.bundleBytes) {
          return err(
            new AnalysisResourceConstraintError(
              OPERATION,
              "file-size",
              `Standalone Hermes bytecode file (${String(fileBytes)} bytes) exceeds the ${String(HERMES_BYTECODE_LIMITS.bundleBytes)}-byte bundle budget`,
              {
                max_bundle_bytes: HERMES_BYTECODE_LIMITS.bundleBytes,
                observed_bytes: fileBytes,
              },
              hermesBudget("the Hermes bundle read allowance", "input"),
            ),
          );
        }
        const buffer = await readExactHandleRange(
          admitted.handle,
          fileBytes,
          0,
        );
        await assertStableRegularFileIdentity(
          admitted.handle,
          input.path,
          admitted.initial,
          {
            symlinks: "follow",
            ...(signal === undefined ? {} : { signal }),
          },
        );
        const sha256 = createHash("sha256").update(buffer).digest("hex");
        const parsed = parseHermesBytecodeBuffer(buffer, {
          entryPath: null,
          sha256,
          query: input.query,
          stringKind: input.string_kind,
          offset: input.offset,
          limit: input.limit,
        });
        if (!parsed.ok) {
          return err(
            new AnalysisInputError(
              OPERATION,
              { userMessage: parsed.message },
              [{ path: ["path"], reason: "invalid_format", message: parsed.message }],
            ),
          );
        }
        return ok({
          target: {
            selected_path: input.path,
            resolved_path: resolvedPath,
            bytes: fileBytes,
            sha256,
            target_kind: "bytecode-file",
          },
          hermes_detected: true,
          bundles: [parsed.summary],
          plain_javascript_bundles: [],
          selected_bundle: parsed.bundle,
          coverage: parsed.complete ? "complete" : "partial",
          limitations: [
            ...parsed.limitations,
            "String-table and function-header rows reflect static Hermes bytecode tables; instruction disassembly and runtime closures are not executed.",
          ],
        });
      }

      if (!isZipPrefix(prefix)) {
        const reason = looksLikeUtf8JavaScriptText(prefix)
          ? "Selected file appears to be UTF-8 JavaScript source rather than compiled Hermes bytecode."
          : "Selected file is neither a Hermes bytecode image (magic 0x1f1903c103bc1fc6) nor a ZIP/APK archive.";
        const remediationAction = looksLikeUtf8JavaScriptText(prefix)
          ? "Inspect plain JavaScript source or bundles with analyze_javascript_application instead."
          : "Pass a compiled Hermes .hbc/.bundle file or an Android APK archive.";
        return err(
          new AnalysisUnsupportedTargetError(
            OPERATION,
            input.path,
            reason,
            { remediationAction },
          ),
        );
      }

      // APK / ZIP container path: compute exact container SHA-256 first, then scan members.
      const apkSha256 = await digestRegularFile(
        admitted.handle,
        fileBytes,
        signal,
      );
      await assertStableRegularFileIdentity(
        admitted.handle,
        input.path,
        admitted.initial,
        {
          symlinks: "follow",
          ...(signal === undefined ? {} : { signal }),
        },
      );

      handoffToZipReader = true;
      const reader = new ZipArtifactReader(
        input.path,
        "apk",
        HERMES_BYTECODE_LIMITS.apkMetadataReadBytes,
        admitted,
      );
      try {
        const candidates: ArtifactEntry[] = [];
        let explicitEntry: ArtifactEntry | undefined;

        for await (const entry of reader.entries(signal)) {
          if (entry.kind !== "file" || entry.encrypted) continue;
          if (input.entry_path !== undefined && entry.path === input.entry_path)
            explicitEntry = entry;
          if (isCandidateApkBundleEntry(entry.path)) candidates.push(entry);
        }

        if (input.entry_path !== undefined && explicitEntry === undefined) {
          return err(
            new AnalysisInputError(
              OPERATION,
              {
                userMessage: `Selected APK does not contain an unencrypted regular file at entry_path ${JSON.stringify(input.entry_path)}.`,
                conformsToInputContract: true,
              },
              [
                {
                  path: ["entry_path"],
                  reason: "invalid_value",
                  message: `Archive member ${JSON.stringify(input.entry_path)} was not found in ${input.path}.`,
                },
              ],
            ),
          );
        }

        const toInspect =
          explicitEntry !== undefined &&
          !candidates.some(({ path }) => path === explicitEntry.path)
            ? [...candidates, explicitEntry]
            : candidates;

        let scannedBytes = 0;
        const summaries: HermesBundleSummary[] = [];
        const hermesBuffers = new Map<
          string,
          { readonly buffer: Buffer; readonly sha256: string }
        >();
        const plainJsBundles: string[] = [];

        for (const entry of toInspect) {
          if (
            entry.declaredSize !== null &&
            entry.declaredSize > HERMES_BYTECODE_LIMITS.bundleBytes
          ) {
            if (entry.path === input.entry_path) {
              return err(
                new AnalysisResourceConstraintError(
                  OPERATION,
                  "file-size",
                  `Archive member ${entry.path} (${String(entry.declaredSize)} bytes) exceeds the ${String(HERMES_BYTECODE_LIMITS.bundleBytes)}-byte Hermes bundle budget`,
                  {
                    max_bundle_bytes: HERMES_BYTECODE_LIMITS.bundleBytes,
                    observed_bytes: entry.declaredSize,
                  },
                  hermesBudget("the Hermes bundle read allowance", "input"),
                ),
              );
            }
            continue;
          }
          if (
            scannedBytes + (entry.declaredSize ?? 0) >
              HERMES_BYTECODE_LIMITS.totalCandidateScanBytes &&
            entry.path !== input.entry_path
          )
            continue;

          const memberBytes = await readZipEntryBounded(
            reader,
            entry,
            HERMES_BYTECODE_LIMITS.bundleBytes,
            signal,
          );
          scannedBytes += memberBytes.byteLength;

          if (detectHermesMagic(memberBytes) !== null) {
            const memberSha = createHash("sha256")
              .update(memberBytes)
              .digest("hex");
            const summary = summarizeHermesBytecodeBuffer(
              memberBytes,
              entry.path,
              memberSha,
            );
            if (summary !== null) {
              summaries.push(summary);
              hermesBuffers.set(entry.path, {
                buffer: memberBytes,
                sha256: memberSha,
              });
            } else if (entry.path === input.entry_path) {
              return err(
                new AnalysisInputError(
                  OPERATION,
                  {
                    userMessage: `Selected archive member ${JSON.stringify(entry.path)} carries Hermes magic bytes but is truncated (${String(memberBytes.byteLength)} bytes).`,
                  },
                  [
                    {
                      path: ["entry_path"],
                      reason: "invalid_format",
                      message: `Truncated Hermes bytecode header in ${entry.path}.`,
                    },
                  ],
                ),
              );
            }
          } else if (isAndroidJavaScriptBundlePath(entry.path)) {
            if (looksLikeUtf8JavaScriptText(memberBytes))
              plainJsBundles.push(entry.path);
            if (entry.path === input.entry_path) {
              return err(
                new AnalysisUnsupportedTargetError(
                  OPERATION,
                  input.path,
                  `Archive member ${JSON.stringify(entry.path)} is not compiled Hermes bytecode${looksLikeUtf8JavaScriptText(memberBytes) ? " (appears to be plain UTF-8 JavaScript)" : ""}.`,
                  {
                    remediationAction:
                      "Extract the APK with extract_artifact and analyze plain UTF-8 JavaScript bundles with analyze_javascript_application.",
                  },
                ),
              );
            }
          } else if (entry.path === input.entry_path) {
            return err(
              new AnalysisUnsupportedTargetError(
                OPERATION,
                input.path,
                `Archive member ${JSON.stringify(entry.path)} does not start with Hermes bytecode magic (0x1f1903c103bc1fc6).`,
              ),
            );
          }
        }

        summaries.sort((left, right) =>
          compareUnicodeCodePoints(left.entry_path ?? "", right.entry_path ?? ""),
        );
        plainJsBundles.sort(compareUnicodeCodePoints);

        if (summaries.length === 0) {
          return ok({
            target: {
              selected_path: input.path,
              resolved_path: resolvedPath,
              bytes: fileBytes,
              sha256: apkSha256,
              target_kind: "apk-container",
            },
            hermes_detected: false,
            bundles: [],
            plain_javascript_bundles: plainJsBundles,
            selected_bundle: null,
            coverage: "complete",
            limitations: [
              ...(plainJsBundles.length > 0
                ? [
                    `No Hermes bytecode magic was found, but plain UTF-8 JavaScript bundle member(s) were observed (${plainJsBundles.join(", ")}); extract with extract_artifact and run analyze_javascript_application.`,
                  ]
                : [
                    "No Hermes bytecode (.hbc / React Native Hermes .bundle) member was observed in candidate APK bundle paths.",
                  ]),
            ],
          });
        }

        const chosenPath =
          input.entry_path ??
          selectDefaultHermesEntryPath(
            summaries.flatMap(({ entry_path: p }) => (p === null ? [] : [p])),
          )!;
        const chosen = hermesBuffers.get(chosenPath)!;
        const parsed = parseHermesBytecodeBuffer(chosen.buffer, {
          entryPath: chosenPath,
          sha256: chosen.sha256,
          query: input.query,
          stringKind: input.string_kind,
          offset: input.offset,
          limit: input.limit,
        });
        if (!parsed.ok) {
          return err(
            new AnalysisInputError(
              OPERATION,
              { userMessage: parsed.message },
              [{ path: ["path"], reason: "invalid_format", message: parsed.message }],
            ),
          );
        }

        return ok({
          target: {
            selected_path: input.path,
            resolved_path: resolvedPath,
            bytes: fileBytes,
            sha256: apkSha256,
            target_kind: "apk-container",
          },
          hermes_detected: true,
          bundles: summaries,
          plain_javascript_bundles: plainJsBundles,
          selected_bundle: parsed.bundle,
          coverage: parsed.complete ? "complete" : "partial",
          limitations: [
            ...parsed.limitations,
            "String-table and function-header rows reflect static Hermes bytecode tables; instruction disassembly and runtime closures are not executed.",
          ],
        });
      } finally {
        await reader.close();
      }
    } catch (cause: unknown) {
      return err(mapFailure(input.path, cause));
    } finally {
      if (admitted !== undefined && !handoffToZipReader) {
        await new OwnedFileHandle(admitted.handle).close().catch(() => undefined);
      }
    }
  }
}
