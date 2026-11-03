import type { Logger } from "pino";

import type { HermesBytecodeService } from "../application/hermes/HermesBytecodeService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { hermesBytecodeModule } from "../composition/hermes.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind the Hermes bytecode contract to shared validation and session Evidence. */
export const registerHermesTools = (
  server: EvidenceMcpServer,
  service: Pick<HermesBytecodeService, "inspect">,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = hermesBytecodeModule.contract;
  const handler = createEvidenceToolHandler(
    server,
    (input, options) => service.inspect(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    handler(contract),
  );
};
