import { createHash } from "node:crypto";
import type { DirectReviewConfig } from "../config.js";
import { TOOL_SCHEMA_EPOCH } from "../version.js";
import { stableJsonStringify } from "../utils/stableJson.js";

export function computeDirectReviewPolicyHash(policy: DirectReviewConfig): string {
  return createHash("sha256")
    .update(stableJsonStringify({
      schema_epoch: TOOL_SCHEMA_EPOCH,
      mode: policy.mode,
      requester_agent_name: policy.requesterAgentName || null,
      reviewer_agent_name: policy.reviewerAgentName || null,
      auto_review_required: policy.autoReviewRequired,
      ttl_seconds: policy.ttlSeconds,
      policy_version: "direct-review-v2",
    }))
    .digest("hex");
}

