# Policy Gateway Pseudo-Wrapper

This example communicates an integration pattern. It is not executable code,
not a current PatchWarden public API, and not a proposal to refactor the core.

```text
incoming request
  -> normalize operation
  -> evaluate risk
  -> create approval ticket if needed
  -> execute only if allowed
  -> write audit event
```

## Suggested Contracts

```ts
type IntegrationRisk = "low" | "medium" | "high" | "critical";
type PolicyOutcome = "allow" | "needs_confirm" | "blocked";

interface NormalizedOperation {
  request_id: string;
  agent_id: string;
  workspace: string;
  tool_name: string;
  operation_type:
    | "read"
    | "write"
    | "delete"
    | "command"
    | "package_install"
    | "git_remote"
    | "network"
    | "sampling";
  args_hash: string;
  target_summary: string;
  policy_snapshot_id: string;
}

interface PolicyDecision {
  risk_level: IntegrationRisk;
  decision: PolicyOutcome;
  reason: string;
  reason_codes: string[];
  policy_snapshot_id: string;
  expires_at?: string;
}

interface ApprovalTicket {
  id: string;
  request_id: string;
  decision_hash: string;
  created_at: string;
  expires_at: string;
  status: "pending" | "approved" | "denied" | "expired";
}

interface AuditEvent {
  agent_id: string;
  workspace: string;
  tool_name: string;
  operation_type: NormalizedOperation["operation_type"];
  args_hash: string;
  risk_level: IntegrationRisk;
  decision: PolicyOutcome;
  reason: string;
  snapshot_id: string;
  timestamp: string;
  user_confirmation_id?: string;
  execution_result: "not_executed" | "ok" | "error";
}
```

The wrapper should hash canonical arguments rather than persist raw values.
`target_summary` must be bounded and redacted. An approval must be bound to the
operation, policy snapshot, and expiry so it cannot authorize a changed request.

## Pseudocode

```ts
async function handleIncoming(request: IncomingRequest): Promise<unknown> {
  const operation = normalize(request);
  let decision = await policy.evaluate(operation);
  let confirmationId: string | undefined;

  if (decision.decision === "needs_confirm") {
    const ticket = await approvals.create(operation, decision);
    confirmationId = ticket.id;

    const resolved = await approvals.waitForLocalHuman(ticket.id);
    decision = await policy.revalidate(operation, resolved);
  }

  if (decision.decision !== "allow") {
    await audit.write(toAuditEvent({
      operation,
      decision,
      confirmationId,
      executionResult: "not_executed",
    }));
    throw new PolicyDenied(decision.reason);
  }

  try {
    const result = await executor.execute(operation, request);
    await audit.write(toAuditEvent({
      operation,
      decision,
      confirmationId,
      executionResult: "ok",
    }));
    return result;
  } catch (error) {
    await audit.write(toAuditEvent({
      operation,
      decision,
      confirmationId,
      executionResult: "error",
    }));
    throw error;
  }
}
```

## Required Properties

- Normalize and validate the workspace before policy evaluation.
- Reject paths outside the workspace and sensitive paths before execution.
- Treat an expired, denied, stale, or mismatched ticket as blocked.
- Re-evaluate after approval so workspace or policy changes invalidate the
  earlier decision.
- Never let the requester approve its own medium-risk ticket.
- Record allowed, blocked, failed, and expired outcomes.
- Keep raw arguments, tokens, cookies, environment secrets, and file content
  out of the audit event.
- Use OS-level isolation when the backend itself must be contained.

PatchWarden v1.6.6 currently uses `low`, `medium`, and `high` risk values and
`allow`, `needs_confirm`, and `blocked` decisions. In this integration example,
`critical` is a documentation-level category whose default result is blocked.
