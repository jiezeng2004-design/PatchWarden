# Safety-Aware Generated CLIs with MCPorter

Status checked 2026-07-28: documentation PR
[#238](https://github.com/openclaw/mcporter/pull/238) was merged on 2026-07-27.
The merged guidance does not add a PatchWarden adapter or make PatchWarden an
official MCPorter integration.

Target: [openclaw/mcporter](https://github.com/openclaw/mcporter)

MCPorter discovers configured MCP servers, exposes typed TypeScript clients,
and generates single-purpose CLIs. This makes MCP tools easier to compose, but
it can also move tool execution outside the approval UI of the client that
originally configured the server.

A generated CLI should therefore have an optional policy-wrapper pattern for
deployments that need pre-execution decisions and audit evidence.

```text
Codex / OpenCode / Claude
  -> MCPorter discovers MCP config
  -> MCPorter generates CLI
  -> external policy wrapper evaluates CLI request
  -> policy decision
  -> actual MCP tool call
  -> redacted audit log
```

PatchWarden can be one external wrapper implementation. It adds dynamic risk
assessment to static tool filtering: the same tool may be allowed for a bounded
read, require confirmation for a write, and be blocked for sensitive paths or
destructive arguments.

MCPorter's record/replay fixtures can also become security regression inputs.
Fixtures should be redacted before storage and should cover allow, confirmation,
block, and policy-change cases without retaining credentials or OAuth data.

## Minimal Wrapper Pseudocode

```ts
async function guardedGeneratedCli(request: CliRequest): Promise<CallResult> {
  const operation = normalizeGeneratedCall({
    agentId: request.agentId ?? "generated-cli",
    workspace: process.cwd(),
    server: request.server,
    tool: request.tool,
    arguments: request.arguments,
  });

  let decision = await policyGateway.evaluate(operation);

  if (decision.decision === "needs_confirm") {
    const ticket = await policyGateway.createApproval(operation, decision);
    decision = await localApproval.resolve(ticket);
  }

  if (decision.decision !== "allow") {
    await audit.append(operation, decision, "not_executed");
    throw new PolicyDeniedError(decision.reason);
  }

  const result = await mcporter.call(request.server, request.tool, request.arguments);
  await audit.append(operation, decision, "ok");
  return result;
}
```

These names are conceptual and are not current MCPorter or PatchWarden APIs.
An upstream document should adapt the example to MCPorter's supported runtime
and generated-CLI extension points.

## Pull Request Draft

Title:

> docs: add safety-aware generated CLI pattern

Description:

> Document an optional policy-wrapper pattern for generated MCP CLIs. The
> pattern evaluates normalized server/tool/argument data before dispatch,
> supports human approval, and writes a redacted audit record after allowed,
> blocked, and failed calls. It complements static tool filtering and reuses
> redacted record/replay fixtures for security regression tests. PatchWarden is
> listed only as an optional external gateway example.

## Test Plan Draft

- Render and link-check the new documentation.
- Verify an allowed fixture reaches the MCPorter call exactly once.
- Verify confirmation and blocked fixtures cannot reach the underlying tool
  before an allow decision.
- Replay a redacted fixture set and compare stable policy outcomes.
- Verify fixture and audit output excludes environment secrets, OAuth state,
  raw tokens, and unredacted sensitive arguments.

The 2026-07-25 upstream review confirmed `docs/cli-generator.md` and
`docs/record-replay.md` as the existing documentation locations. Merged PR #238
updates those files without adding a PatchWarden adapter or public API claim.
