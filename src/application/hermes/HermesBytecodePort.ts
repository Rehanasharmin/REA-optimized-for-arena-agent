import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import type {
  HermesBytecodeResult,
  InspectHermesBytecodeInput,
} from "../../domain/hermes/hermesBytecode.js";
import type { Result } from "../../domain/result.js";

/** Port for pure-TypeScript Hermes bytecode and APK bundle inspection. */
export interface HermesBytecodePort {
  readonly identity: Evidence["provider"];
  inspect(
    input: InspectHermesBytecodeInput,
    options?: ExecutionOptions,
  ): Promise<Result<HermesBytecodeResult, AnalysisError>>;
  close(): Promise<void>;
}
