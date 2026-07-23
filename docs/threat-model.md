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
| Evidence secret persistence | An agent writes a token into a normal source file and the Git diff duplicates it under `.patchwarden`. | Diff evidence is capped at 20 MiB, redacted before persistence, and credential-like content produces a policy violation. |
| Artifact-directory confusion | A secret-shaped filename is placed under `.patchwarden` and assumed safe because it is an internal artifact. | The sensitive-name guard applies at every depth; `.patchwarden` has no blanket exemption. |
| Concurrent Goal/worktree mutation | Two MCP processes accept subgoals or create/merge/discard worktrees at the same time and lose state or corrupt repository lifecycle. | Goal mutations share a cross-process lock and atomic replacement; worktree repository mutations share a lifecycle lock. |
| Evidence resource exhaustion | Oversized task logs or a large documentation tree consume unbounded memory, response size, or disk. | Task and Control reads use bounded prefix/tail reads, audit scans enforce file/byte budgets, and persistent invocation/reconcile logs use locked bounded append with explicit truncation. |
| DNS rebinding | A hostile web origin resolves to `127.0.0.1` and tries to read the Control token or call HTTP MCP. | Control Center and HTTP MCP reject Host headers other than the configured `127.0.0.1`/`localhost` origin. |
| Live-service disruption | A task restarts tunnels, watchers, or unrelated processes. | Project rules forbid blanket process kills; live cutover must be explicit and separately approved. |

## Security Invariants

PatchWarden changes should preserve these invariants:

- no general-purpose remote shell
- all task repositories stay under `workspaceRoot`
- agents are explicitly registered before use
- child processes receive a minimal environment; provider variables require an
  explicit per-agent `envAllowlist`, and Tunnel owner credentials are never
  forwarded
- model input cannot define arbitrary agent launch commands
- verification commands use exact allowlist matching
- sensitive paths remain blocked at every directory depth, including under
  `.patchwarden`
- task artifacts remain auditable and redacted where appropriate
- Goal status mutations and worktree repository lifecycle changes are
  cross-process serialized; a non-empty Goal becomes completed only after all
  subgoals are accepted
- subgoal tasks use the Goal's stored `repo_path` as authority and reject a
  caller-supplied repository mismatch
- task/audit/log read and append paths enforce explicit byte, line, or file
  budgets and report truncation
- Direct patch/sync accepts only bounded UTF-8 text, rejects credential-like
  results, and serializes session mutations
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
