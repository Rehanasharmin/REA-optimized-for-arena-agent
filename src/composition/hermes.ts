import { HermesBytecodeService } from "../application/hermes/HermesBytecodeService.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { INSPECT_HERMES_BYTECODE_CONTRACT } from "../contracts/hermes/hermesToolContracts.js";
import { HermesBytecodeProvider } from "../hermes/HermesBytecodeProvider.js";

/** Compose the pure-TypeScript Hermes bytecode inspector without external binaries. */
export const createHermesBytecodeService = (): HermesBytecodeService =>
  new HermesBytecodeService(new HermesBytecodeProvider());

export const hermesBytecodeModule = {
  contract: INSPECT_HERMES_BYTECODE_CONTRACT,
  cliCommand: CLI_COMMANDS.inspectHermesBytecode,
  create(
    _environment?: Readonly<NodeJS.ProcessEnv>,
    injected?: HermesBytecodeService,
  ): Pick<HermesBytecodeService, "inspect" | "close"> {
    const service = injected ?? createHermesBytecodeService();
    return {
      inspect: service.inspect.bind(service),
      close: service.close.bind(service),
    };
  },
} as const;
