import {
  hermesBytecodeResultSchema,
  inspectHermesBytecodeInputSchema,
} from "../../domain/hermes/hermesBytecode.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

export const INSPECT_HERMES_BYTECODE_CONTRACT = {
  name: "inspect_hermes_bytecode",
  ...toolContractMetadata("inspect_hermes_bytecode"),
  kind: "artifact-provider",
  description:
    "Inspect React Native Hermes bytecode (.hbc, .bundle, .jsbundle) either directly or inside a local Android APK without external tools or code execution. Parses BytecodeFileHeader (execution/delta magic, version, source SHA-1, table counts, BytecodeOptions), verifies BytecodeFileFooter SHA-1 integrity when present, decodes SmallStringTableEntry/OverflowStringTableEntry + StringKind RLE (identifier vs literal string, ASCII/UTF-16LE), and decodes SmallFuncHeader/FunctionHeader metadata (function names, parameter counts, bytecode byte sizes, frame sizes, strict/exception/debug flags for Hermes v59-v96). Supports query substring filtering, string_kind filtering, and offset/limit paging. Reports hermes_detected: false (plus any plain UTF-8 JS bundle paths) when an APK carries no Hermes bytecode.",
  inputSchema: inspectHermesBytecodeInputSchema,
  outputSchema: evidenceResultOf(hermesBytecodeResultSchema),
  examples: [
    {
      title: "Inspect Hermes bytecode inside an Android APK",
      input: { path: "/targets/ExampleApp.apk" },
    },
    {
      title: "Search Hermes strings and named functions for authentication logic",
      input: {
        path: "/targets/ExampleApp.apk",
        query: "biometric",
        limit: 50,
      },
    },
    {
      title: "Inspect a standalone Hermes .hbc or index.android.bundle file",
      input: {
        path: "/targets/index.android.bundle",
        string_kind: "identifier",
        offset: 0,
        limit: 100,
      },
    },
  ],
} as const satisfies ToolContract;

export const HERMES_TOOL_CONTRACTS = [
  INSPECT_HERMES_BYTECODE_CONTRACT,
] as const satisfies readonly ToolContract[];
