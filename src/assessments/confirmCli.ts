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

loadConfig();

const assessmentId = process.argv[2];
if (!assessmentId || process.argv.length !== 3) {
  console.error("Usage: patchwarden-confirm <full_assessment_id>");
  console.error("The display-only assessment_short_id is not accepted.");
  process.exit(1);
}

try {
  const result = confirmAssessment(assessmentId);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify(errorPayload(error), null, 2));
  process.exit(1);
}
