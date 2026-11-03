import { z } from "incur";
import type { Logger } from "pino";

import { logCliCommand } from "../cliLogging.js";
import { hermesBytecodeModule } from "../composition/hermes.js";
import {
  evidenceSchema,
  withEvidenceCallerInputPath,
} from "../domain/evidence.js";
import {
  HERMES_BYTECODE_PROVIDER_IDENTITY,
  inspectHermesBytecodeInputSchema,
} from "../domain/hermes/hermesBytecode.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { bindCliEvidenceCallerPath } from "./cliEvidenceCallerPath.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import type { CliInstance } from "./types.js";

/** Expose pure-TypeScript Hermes bytecode and APK bundle inspection via CLI. */
export const registerHermesCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): void => {
  cli.command(hermesBytecodeModule.cliCommand, {
    description:
      "Inspect React Native Hermes bytecode (.hbc / .bundle) directly or inside an APK",
    args: z.object({
      path: inspectHermesBytecodeInputSchema.shape.path,
    }),
    options: z.object({
      entry_path: inspectHermesBytecodeInputSchema.shape.entry_path,
      query: inspectHermesBytecodeInputSchema.shape.query,
      string_kind: inspectHermesBytecodeInputSchema.shape.string_kind,
      offset: inspectHermesBytecodeInputSchema.shape.offset,
      limit: inspectHermesBytecodeInputSchema.shape.limit,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, hermesBytecodeModule.cliCommand, () => {
          const service = hermesBytecodeModule.create(environment);
          const input = {
            path: absoluteCallerPath(args.path),
            ...(options.entry_path === undefined
              ? {}
              : { entry_path: options.entry_path }),
            ...(options.query === undefined ? {} : { query: options.query }),
            ...(options.string_kind === undefined
              ? {}
              : { string_kind: options.string_kind }),
            ...(options.offset === undefined ? {} : { offset: options.offset }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          };
          return finishAnalysisCommand(
            bindCliEvidenceCallerPath(args.path, () =>
              service.inspect(input, { signal }),
            ),
            service,
            HERMES_BYTECODE_PROVIDER_IDENTITY.id,
            hermesBytecodeModule.contract.name,
            signal,
            undefined,
            {
              recoverCompletedObservation: (observation) => {
                const parsed = evidenceSchema.safeParse(observation);
                return parsed.success
                  ? withEvidenceCallerInputPath(parsed.data, args.path)
                  : undefined;
              },
            },
          ).then(projectCliAnalysisResult);
        }),
      ),
  });
};
