# Policy-Gated Tool Calls for mcp-agent

Status checked 2026-07-28: PR [#723](https://github.com/lastmile-ai/mcp-agent/pull/723)
is open and ready for review. It is not merged and is not an existing
mcp-agent integration.

Target: [lastmile-ai/mcp-agent](https://github.com/lastmile-ai/mcp-agent)

## Motivation

mcp-agent composes agents, MCP servers, sampling, and durable workflows. Tool
lifecycles and durability do not by themselves answer whether a proposed local
action should execute. High-risk calls need a deterministic policy decision,
an optional human approval step, and durable audit evidence before execution.

PatchWarden can be one optional external approval gateway. The example should
remain gateway-neutral so applications can replace it with another policy
service.

```text
MCP Agent
  -> proposes tool call
  -> external gateway evaluates risk
  -> low risk: allow
  -> medium risk: require human approval
  -> high risk: block
  -> audit event persisted
```

## Recommended Default Policy

| Operation | Recommended default |
| --- | --- |
| Allowlisted, bounded read-only call | Low: allow and record |
| Scoped file write | Medium: require confirmation |
| Project-local, pinned package install | Medium: require confirmation |
| File deletion or unknown shell command | High: block by default |
| `git push` | High: block by default |
| `git push --force` or history rewrite | Critical: prohibit |
| Sensitive-path access or out-of-workspace write | Critical: prohibit |
| Exfiltration-like command using network tools and local data | Critical: prohibit |
| MCP sampling with reviewed, non-sensitive context | Medium: require confirmation |
| MCP sampling containing sensitive data | High or Critical: block |

These four levels are an integration recommendation. PatchWarden's current
runtime emits only `low`, `medium`, and `high`; Critical-class operations map to
hard-rule `high + blocked` decisions.

## Framework-Neutral Pseudocode

```python
async def guarded_call(agent, proposed_call, gateway, approval_ui, audit_store):
    operation = normalize_tool_call(
        agent_id=agent.name,
        workspace=agent.workspace,
        tool_name=proposed_call.name,
        arguments=proposed_call.arguments,
    )

    decision = await gateway.evaluate(operation)

    if decision.decision == "needs_confirm":
        ticket = await gateway.create_approval_ticket(operation, decision)
        approved = await approval_ui.wait_for_human(ticket)
        decision = await gateway.resolve_approval(ticket.id, approved)

    if decision.decision != "allow":
        await audit_store.append(operation, decision, result="not_executed")
        return denied_tool_result(decision.reason)

    try:
        result = await agent.call_tool(proposed_call)
        await audit_store.append(operation, decision, result="ok")
        return result
    except Exception as error:
        await audit_store.append(operation, decision, result="error", error=error)
        raise
```

The functions above are conceptual interfaces. They are not current
PatchWarden or mcp-agent API names. The 2026-07-25 upstream review confirmed
that `AugmentedLLM.pre_tool_call` and `post_tool_call` are current framework
hooks; the local spike uses `pre_tool_call` for the dispatch decision.

Normalization should explicitly classify:

- shell command and command arguments
- filesystem read, write, rename, and delete
- Git push, force push, tag, and release operations
- local or global package installation
- network commands that combine local reads with outbound requests
- MCP sampling requests, requested model context, and expected cost

Only an allowed decision should reach the actual MCP tool. The audit path must
also record blocked calls and failed executions, while hashing or redacting
arguments that may contain secrets.

## Contribution Draft

Title:

> examples: add human approval gate for high-risk MCP tool calls

Issue or PR description:

> Add a framework-neutral example that evaluates an MCP tool call before
> dispatch, requests human approval for medium-risk operations, blocks
> high-risk operations, and persists a redacted audit event for every outcome.
> The example uses a replaceable policy-gateway interface; PatchWarden may be
> documented as one optional implementation rather than a required dependency.
> The example uses the current `AugmentedLLM.pre_tool_call` hook and a replaceable
> approval callback. It documents that direct `Agent.call_tool` calls and native
> MCP sampling bypass this hook and need separate governance points.

## Test Plan Draft

- Fake gateway returns allow: underlying MCP tool runs once and an `ok` event
  is persisted.
- Fake gateway requires confirmation: the tool does not run before approval.
- Approval is denied or expires: the tool never runs and denial is audited.
- Fake gateway blocks: shell, delete, push, force-push, package install,
  exfiltration-like, and sampling fixtures are not dispatched.
- Tool execution fails after approval: the error is re-raised and audited.
- Audit records contain argument digests or redacted summaries, never raw
  credentials.
- Durable workflow replay does not duplicate an already resolved approval or
  execute the underlying tool twice.

The pre-dispatch hook is confirmed. Durable replay semantics and a native
sampling approval hook remain maintainer questions rather than claims made by
the example.
