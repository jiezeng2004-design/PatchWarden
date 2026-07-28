# External Contribution Plan

This document tracks proposed contributions. It does not claim official support
or an accepted integration in any target project. Re-check each target's current
default branch, contribution guide, issue state, and schema immediately before
submitting anything.

## Priority Table

| Target repo | Link | Proposed contribution | Difficulty | First step | Risk |
| --- | --- | --- | --- | --- | --- |
| `step-security/dev-machine-guard` | [Repository](https://github.com/step-security/dev-machine-guard) | `feat(detector): add PatchWarden detection` | Low | Prepare a binary-first `aicli.go` entry and tests | False positives from stale `.patchwarden/` directories or unsafe version probing |
| `lastmile-ai/mcp-agent` | [Repository](https://github.com/lastmile-ai/mcp-agent) | `examples: add human approval gate for high-risk MCP tool calls` | Medium | Build a framework-native spike and confirm the pre-dispatch hook | Example may use an unsupported interception or durable-workflow pattern |
| `wonderwhy-er/DesktopCommanderMCP` | [Repository](https://github.com/wonderwhy-er/DesktopCommanderMCP) | `docs(security): document external policy gateway pattern` | Low | Adapt the generic gateway document to its security docs | Advertising tone or implying the gateway is a sandbox |
| `openclaw/mcporter` | [Repository](https://github.com/openclaw/mcporter) | `docs: add safety-aware generated CLI pattern` | Medium | Confirm the preferred docs location or open a short design issue | Wrapper may not match generated-CLI extension points or may retain fixture secrets |
| `OpenHands/OpenHands` | [Repository](https://github.com/OpenHands/OpenHands) | `Design note: external governance layer for agent actions` | Low | Find a current maintainer-approved discussion channel before reusing the archived draft | Citing a removed thread or proposing code before an enforcement point is selected |
| `snyk/agent-scan` | [Repository](https://github.com/snyk/agent-scan) | Classification discussion or a PatchWarden fixture | Medium | Discuss expected classification and false-positive behavior | Scanning a stdio MCP can start local code; consent and redaction must remain intact |

## Contribution Decisions

| Target | Immediate PR? | Issue first? | Reusable PatchWarden material | Material still needed |
| --- | --- | --- | --- | --- |
| Dev Machine Guard | Yes, after local upstream tests | No | Package metadata, binary name, config-path facts, security model, detector draft | Upstream fork/branch, exact detector tests, coverage-table update, current CI result |
| mcp-agent | Not from pseudocode alone | Yes if no documented pre-dispatch hook | Risk vocabulary, approval flow, audit schema, gateway pseudocode | Framework-native example, durable replay behavior, maintainer-approved extension point |
| Desktop Commander | Yes, as a small docs PR | No unless requested by its contribution guide | Non-sandbox model, enforcement boundary, generic gateway diagram | Upstream-native wording, exact docs placement, rendered Markdown check |
| MCPorter | After docs-location confirmation | Prefer a short issue or discussion | Generated-CLI threat, wrapper pseudocode, record/replay test idea | Supported extension point, redacted fixture format, maintainers' preferred terminology |
| OpenHands | No implementation PR | Find a current discussion first | Sandbox-vs-governance distinction, policy surfaces, archived comment draft | Current contribution guidance and a maintainer response identifying an enforcement point |
| Snyk Agent Scan | No direct product-integration PR yet | Yes, classification/fixture discussion first | Threat model, config markers, sensitive-path boundary | Expected taxonomy, non-executing fixture, consent-safe test case, false-positive criteria |

## Contribution Status (checked 2026-07-28)

| Target | Verified upstream state | Submission |
| --- | --- | --- |
| Dev Machine Guard | `main` at `2cf07e2` when prepared | PR [#180](https://github.com/step-security/dev-machine-guard/pull/180) is open, non-draft, and mergeable |
| mcp-agent | `AugmentedLLM.pre_tool_call` and `post_tool_call` are current public hooks | PR [#723](https://github.com/lastmile-ai/mcp-agent/pull/723) is open, non-draft, and mergeable, with five focused tests |
| Desktop Commander | Issue [#431](https://github.com/wonderwhy-er/DesktopCommanderMCP/issues/431) already discusses external policy enforcement | PR [#611](https://github.com/wonderwhy-er/DesktopCommanderMCP/pull/611) is open, non-draft, and mergeable; it is related to but does not close #431 |
| MCPorter | Existing policy-relevant homes are `docs/cli-generator.md` and `docs/record-replay.md` | Documentation PR [#238](https://github.com/openclaw/mcporter/pull/238) merged on 2026-07-27 |
| OpenHands | The previously recorded Issue #15377 and comment no longer resolve through the GitHub API | Treat [the local design note](integrations/openhands-governance.md) as an archived draft, not a posted comment |
| Snyk Agent Scan | `CONTRIBUTING.md` says the project is closed to external contributions | Classification comment [posted on #392](https://github.com/snyk/agent-scan/issues/392#issuecomment-5077566202); no fixture PR |

The three open PRs remain proposals. MCPorter PR #238 is merged documentation,
but it does not add a PatchWarden adapter or establish official PatchWarden
support. The Snyk comment is live; the previously recorded OpenHands thread is
not. None of these states proves that all calls in another product are governed
by PatchWarden.

## Per-Target Notes

### 1. StepSecurity Dev Machine Guard

Recommended first external contribution. Detection is objective and small.
Reuse [the detector proposal](integrations/dev-machine-guard.md). Keep the first
PR binary-first and map PatchWarden to the existing `cli_tool` schema. Do not
add a new JSON category or treat project artifacts as installation evidence.

### 2. lastmile-ai/mcp-agent

Reuse [the policy-gated tool-call draft](integrations/mcp-agent.md), but replace
conceptual functions with current mcp-agent APIs. The contribution should teach
a general approval pattern rather than require PatchWarden.

The current spike uses `AugmentedLLM.pre_tool_call`. It explicitly excludes
direct `Agent.call_tool` calls and native MCP sampling, which require their own
enforcement points.

### 3. Desktop Commander MCP

Reuse [the external gateway draft](integrations/desktop-commander.md). Preserve
Desktop Commander's own distinction between guardrails and sandboxing, and keep
PatchWarden in an optional examples paragraph.

Reference open Issue #431 as related discussion; do not present a generic docs
patch as resolving its product-level enforcement request.

### 4. MCPorter

Reuse [the generated-CLI wrapper draft](integrations/mcporter.md). The strongest
contribution is a generic safety pattern plus redacted record/replay tests, not
a PatchWarden-specific command that does not exist.

The upstream documentation locations are `docs/cli-generator.md` and
`docs/record-replay.md`; PR #238 merged the safety guidance into those files.

### 5. OpenHands

Treat [the prepared governance note](integrations/openhands-governance.md) as an
archived draft. Do not cite its removed thread or open a large PR. First locate
a current public discussion and wait for maintainers to identify whether the
policy boundary belongs in runtime dispatch, EventStream, or an external adapter.

### 6. Snyk Agent Scan

Agent Scan already asks for user consent before launching stdio MCP servers,
but its current contribution policy rejects external code contributions. Limit
this round to a comment on open Issue #392 about taxonomy and documentation
false positives. Do not submit a fixture PR, weaken consent, echo MCP
environment values, or claim PatchWarden's presence proves all local agent
calls are governed.

## Reference Project

[Runtime Guard](https://github.com/runtimeguard/runtime-guard) is an important
design reference for runtime policy, command blocking, human approval, backups,
workspace boundaries, and audit logs. It is not a contribution target in this
round. PatchWarden documentation should describe the shared policy-gateway
pattern without claiming feature parity.
