# PatchWarden v0.4.0

PatchWarden v0.4.0 hardens the ChatGPT-to-local-agent task loop without
weakening workspace, command, or sensitive-file boundaries.

This release also completes the project rename from Safe-Bifrost to
PatchWarden. The npm package is now `patchwarden`; the old package is retained
only to point existing users to the new name.

## Highlights

- Adds supervised Windows tunnel recovery with local readiness probes,
  structured failure categories, capped retry backoff, and redacted runtime
  state under `%LOCALAPPDATA%\patchwarden\runtime`.
- Adds `Check-PatchWarden-Health.cmd` for diagnostics when the MCP tunnel itself
  is unreachable.
- Expands `health_check` with workspace, tasks directory, watcher, agent, tunnel,
  and last-error evidence; local HTTP `/healthz` and `/readyz` are also available.
- Lets `create_task` use exactly one of a saved `plan_id`, persisted
  `inline_plan`, or a guarded task template.
- Adds `inspect_only`, `feature_small`, `fix_tests`, `release_check`, and safe
  review-only `rollback_scope_violation` templates.
- Enforces no-change templates with `failed_policy_violation`.
- Adds deterministic failure guidance through `failure_reason`,
  `failed_command`, `suggested_next_action`, and `safe_followup_prompt`.
- Adds standalone `file-stats.json` while preserving complete `diff.patch`,
  `changed-files.json`, and the v0.3.0 acceptance contract.
- Adds deterministic `full` and `chatgpt_core` tool profiles. Tunnel stdio uses
  an exact 16-tool core manifest while ordinary local launches remain on the
  22-tool full profile.
- Adds schema-inclusive tool manifest hashing, `schema_epoch`, server version,
  and a real MCP stdio preflight before tunnel startup.
- Adds structured `create_task.next_tool_call`, preferred
  `wait_for_task(timeout_seconds)`, legacy `wait_seconds` compatibility, and a
  complete terminal summary in the wait response.
- Adds recursive redaction for structured result/verification summaries and
  concise verification counts/headlines such as `166 passed`.
- Adds explicit `get_diff.patch_mode` values for textual, no-change, and
  hash-only evidence, including a reason when a textual patch is unavailable.
- Enhances the local health report with process source/version evidence and
  mixed-version warnings without automatically ending any process.
- Adds first-class watcher stale/missing evidence, structured pending artifact
  responses, and controlled recovery for launcher-owned watcher processes.
- Reports stale client catalogs as `tool_catalog_mismatch` with the active
  profile, schema epoch, manifest hash, and Connector refresh guidance.
- Fixes a plan-guard bypass where generic security wording could suppress a
  later credential-access instruction. Every dangerous occurrence is now
  evaluated independently and only directly negated actions are allowed.

## Compatibility

The MCP tool names and `save_plan` -> `create_task` workflow remain stable, but
the product rename is intentionally breaking: old CLI names, `SAFE_BIFROST_*`
variables, `safe-bifrost.config.json`, `.safe-bifrost/`, and legacy AppData
paths are not loaded. Follow the migration guide before replacing an existing
installation. `repo_path`, configured agent validation, and exact
verification-command allowlists remain mandatory.

## Verification

Run the following from Windows PowerShell:

```powershell
npm.cmd test
npm.cmd run test:mcp
npm.cmd run test:http-mcp
npm.cmd run doctor
npm.cmd run check:tool-manifest
npm.cmd run check:brand
npm.cmd run test:tunnel-supervisor
npm.cmd run test:watcher-supervisor
npm.cmd run pack:clean
npm.cmd run verify:package
```
