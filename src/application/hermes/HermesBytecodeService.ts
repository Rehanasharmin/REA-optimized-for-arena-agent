import { parseAnalysisInput } from "../AnalysisInput.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import type { HermesBytecodePort } from "./HermesBytecodePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import type { Evidence } from "../../domain/evidence.js";
import {
  createHermesBytecodeEvidence,
  hermesBytecodeResultSchema,
  inspectHermesBytecodeInputSchema,
} from "../../domain/hermes/hermesBytecode.js";
import { err, type Result } from "../../domain/result.js";

const OPERATION = "inspect_hermes_bytecode";

/** Shared exact input validation and artifact-bound Evidence for CLI and MCP. */
export class HermesBytecodeService {
  constructor(readonly provider: HermesBytecodePort) {}

  async close(): Promise<void> {
    await this.provider.close();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const input = parseAnalysisInput(
      OPERATION,
      rawInput,
      inspectHermesBytecodeInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const inspected = await this.provider.inspect(input.value, options);
    if (!inspected.ok) return inspected;
    const report = hermesBytecodeResultSchema.safeParse(inspected.value);
    if (
      !report.success ||
      report.data.target.selected_path !== input.value.path
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Hermes bytecode reader returned a malformed report or changed the selected artifact identity.",
        ),
      );
    return completeProviderEvidence(
      createHermesBytecodeEvidence(
        input.value,
        report.data,
        this.provider.identity,
      ),
      options?.signal,
    );
  }
}
