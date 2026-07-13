#!/usr/bin/env node
/**
 * Local-only confirmation for medium-risk assessment tickets.
 *
 * This command is deliberately not exposed through the MCP registry. It must
 * be invoked by a person (or another explicitly trusted local workflow) in a
 * terminal that uses the same PatchWarden configuration as the server.
 */

import { loadConfig } from "../config.js";
import { confirmAssessment } from "./assessmentStore.js";
import { errorPayload } from "../errors.js";
import { logger } from "../logging.js";

loadConfig();

const assessmentId = process.argv[2];
if (!assessmentId || process.argv.length !== 3) {
  logger.info("Usage: patchwarden-confirm <full_assessment_id>");
  logger.info("The display-only assessment_short_id is not accepted.");
  process.exit(1);
}

try {
  const result = await confirmAssessment(assessmentId);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  logger.error("confirm_assessment_failed", { error: errorPayload(error) });
  process.exit(1);
}
