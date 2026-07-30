import type { PatchWardenConfig } from "../config.js";
import type { TaskFailureCategory } from "./failureCategories.js";

export type AgentTransitionAction = "stop" | "retry_same_agent" | "switch_agent" | "recover_connector" | "recover_watcher";

export interface AgentTransitionDecision {
  action: AgentTransitionAction;
  next_agent: string | null;
  reason: string;
  consumes_agent_retry: boolean;
}

export function buildAgentPriority(
  config: PatchWardenConfig,
  selectedAgent: string,
): string[] {
  return [...new Set([
    selectedAgent,
    ...(config.agentPriority || []),
  ].filter((agent) => Boolean(config.agents[agent])))];
}

export function decideAgentTransition(input: {
  failure_category: TaskFailureCategory | null;
  current_agent: string;
  current_agent_attempt: number;
  priority: string[];
  max_retries_per_agent: number;
  fallback_on: TaskFailureCategory[];
  do_not_fallback_on: TaskFailureCategory[];
  requested_model?: string;
}): AgentTransitionDecision {
  const category = input.failure_category;
  if (!category) return stop("no_structured_failure_category");
  if (category === "connector_failure") {
    return { action: "recover_connector", next_agent: input.current_agent, reason: category, consumes_agent_retry: false };
  }
  if (category === "watcher_failure") {
    return { action: "recover_watcher", next_agent: input.current_agent, reason: category, consumes_agent_retry: false };
  }
  if (["policy_block", "scope_violation", "user_confirmation_required"].includes(category)
    || input.do_not_fallback_on.includes(category)) {
    return stop(`non_fallback_category:${category}`);
  }
  if (!input.fallback_on.includes(category)) return stop(`fallback_not_configured:${category}`);

  if (input.current_agent_attempt <= input.max_retries_per_agent) {
    return {
      action: "retry_same_agent",
      next_agent: input.current_agent,
      reason: `retry_${category}`,
      consumes_agent_retry: true,
    };
  }

  if (input.requested_model) return stop("requested_model_pins_explicit_agent");
  const currentIndex = input.priority.indexOf(input.current_agent);
  const nextAgent = input.priority.slice(Math.max(0, currentIndex + 1)).find(Boolean) || null;
  if (!nextAgent) return stop(`agent_priority_exhausted:${category}`);
  return {
    action: "switch_agent",
    next_agent: nextAgent,
    reason: `fallback_${category}:${input.current_agent}->${nextAgent}`,
    consumes_agent_retry: false,
  };
}

function stop(reason: string): AgentTransitionDecision {
  return { action: "stop", next_agent: null, reason, consumes_agent_retry: false };
}
