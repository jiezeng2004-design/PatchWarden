# PatchWarden Threat Model

PatchWarden is a local MCP bridge for AI coding workflows. Its core security
goal is to let an MCP client request bounded maintainer tasks without turning
the local machine into a general-purpose remote shell.

## Assets Protected

- source repositories under the configured workspace
- release artifacts and checksums
- task evidence under `.patchwarden/`
- local configuration files
- `.env` files, API keys, tokens, SSH keys, cookies, browser state, and
  credential stores
- maintainer time and trust in verification evidence

## Trust Boundaries

PatchWarden assumes the upstream model or MCP client can be wrong, overbroad, or
prompt-injected. It should not be trusted with unrestricted command execution,
arbitrary filesystem reads, or release authority.

Trusted local configuration includes:

- `workspaceRoot`
- registered agents and their command templates
- `allowedTestCommands`
- project policy files reviewed by the maintainer

Human maintainer confirmation remains required for high-risk actions such as
publishing, pushing, creating releases, changing live services, or approving
local confirmation tickets.

## Main Threats

| Threat | Example | Mitigation |
| --- | --- | --- |
| Arbitrary shell execution | A prompt asks the MCP server to run a custom command. | PatchWarden exposes task tools, not a general shell; verification commands must exactly match allowlists. |
| Path traversal | A task tries to edit `../other-project` or user home files. | Task paths are resolved under `workspaceRoot`; out-of-scope changes are reported as violations. |
| Secret exfiltration | A task asks to read `.env`, SSH keys, cookies, or credentials. | Sensitive path names are blocked and docs require redacted logs. |
| Prompt injection | Repository text instructs the model to ignore safety constraints. | Safety is enforced by local code and configuration, not by prompt instructions alone. |
| Unsafe release claims | A local build passes and the agent claims npm/GitHub publish is complete. | Release docs require separate verification of PR/CI, GitHub Release, npm version, and `dist-tags.latest`. |
| Evidence overload | A client requests full logs, diffs, or private task history by default. | Safe summary tools and bounded evidence packs are the preferred review surfaces. |
| Live-service disruption | A task restarts tunnels, watchers, or unrelated processes. | Project rules forbid blanket process kills; live cutover must be explicit and separately approved. |

## Security Invariants

PatchWarden changes should preserve these invariants:

- no general-purpose remote shell
- all task repositories stay under `workspaceRoot`
- agents are explicitly registered before use
- model input cannot define arbitrary agent launch commands
- verification commands use exact allowlist matching
- sensitive paths remain blocked
- task artifacts remain auditable and redacted where appropriate
- scope violations are surfaced, not silently accepted
- publish, push, tag, release, and live-service operations remain
  confirmation-gated

## Non-Goals

PatchWarden is not a full sandbox, container runtime, endpoint security product,
or secret scanner. It adds policy, task evidence, verification, and review
records around local agent work. It should be used with normal operating-system
permissions, Git review, CI, and maintainer judgment.

## Review Checklist For Security-Sensitive Changes

- [ ] Does the change weaken workspace confinement?
- [ ] Does it expand command execution beyond exact allowlists?
- [ ] Does it expose full logs, diffs, task history, or file contents where a
      safe summary would be enough?
- [ ] Does it read or persist credentials, tokens, cookies, browser state, or
      `.env` content?
- [ ] Does it auto-push, auto-publish, auto-tag, or restart live services?
- [ ] Does it add or update smoke coverage for changed behavior?
- [ ] Does it keep README, examples, tool manifests, package metadata, and
      migration docs aligned?
