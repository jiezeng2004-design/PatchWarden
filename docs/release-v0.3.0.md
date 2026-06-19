# Safe-Bifrost v0.3.0

Safe-Bifrost v0.3.0 makes ChatGPT-managed local agent work easier to monitor,
verify, and accept without weakening the workspace and command boundaries.

## Highlights

- Adds `wait_for_task` so ChatGPT can stay in the tool loop until a task is
  terminal, plus `get_task_summary` for one-call acceptance evidence.
- Requires an explicit existing repository directory and supports both
  workspace-relative and absolute `repo_path` values.
- Adds independent multi-command `verify_commands` while keeping
  `test_command` compatibility.
- Generates structured `result.json`, `verify.json`, readable `verify.log`,
  and a complete `diff.patch` for every terminal task.
- Adds task-scoped file statistics, clear large/no-diff responses, and avoids
  including unchanged pre-existing workspace files in task diff evidence.
- Detects changes outside `resolved_repo_path`, marks the task
  `failed_scope_violation`, invalidates verification acceptance, and creates a
  review-only `rollback_scope_violation_plan.md`.
- Allows ordinary long build/test/release plans while blocking explicit
  credential theft, destructive disk deletion, and malicious persistence.
- Redacts secret-like values in ordinary task artifacts instead of rejecting
  the entire read.
- Expands `doctor`, stdio/HTTP MCP smoke tests, lifecycle coverage, packaging
  checks, and ChatGPT workflow documentation.

## Compatibility note

`create_task` now requires `repo_path`. Existing clients that omitted it must
pass an existing directory under `workspaceRoot`. `test_command` remains
supported and is converted into a one-entry verification list.

## Verification

- `npm test`: 63 security tests, 14 lifecycle tests, and doctor smoke passed
- `npm run test:mcp`: passed
- `npm run test:http-mcp`: 11 passed
- `npm run doctor`: 47 OK, 0 WARN, 0 FAIL
- `npm run pack:clean`: passed
- `npm run verify:package`: passed

Tracked in [issue #1](https://github.com/jiezeng2004-design/safe-bifrost/issues/1).
