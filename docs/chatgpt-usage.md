# ChatGPT 调用规范 / ChatGPT usage guide

## 中文

这套约定用于降低长参数、长轮询、构建产物和完整日志触发连接器误拦截的概率，同时保留 PatchWarden 的本地安全边界和完整证据。

1. 一个任务只处理一个目标；功能实现、耗时构建和 Git/发布收尾分开执行。
2. 计划标题使用短英文 slug，详细说明放在目标或计划正文中。
3. ChatGPT 优先使用守护模板：只读诊断用 `inspect_only`，小范围修改用 `feature_small`，修复已知失败用 `fix_tests`。模板不够表达目标时才使用 `inline_plan` 或保存的长计划。
4. 创建任务时优先采用 assess → execute 两步流程。execute 必须直接使用 assess 返回的 `next_tool_call`，不要重复发送 goal、plan、repo、agent 或验证命令。
5. 短任务可以调用 `wait_for_task(timeout_seconds: 25)`；长任务使用 `list_tasks(repo_path=..., active_only=true)` 和 `get_task_status`。
6. 终态先读取 `get_task_summary(view: "compact")` 和 `audit_task`；证据不足时才读取 standard 摘要、完整 diff 或日志。
7. 构建验证与源码任务分开。`artifact_hygiene` 会区分源码、已跟踪构建物、忽略产物、运行态文件和可疑变更。
8. PatchWarden 保留未提交改动供人工审核；提交、推送和发布不属于普通任务范围。

### assess → execute

第一步发送完整目标：

```json
{
  "tool": "create_task",
  "execution_mode": "assess_only",
  "template": "feature_small",
  "goal": "Add a bounded activity timeline UI",
  "agent": "opencode",
  "repo_path": "my-project",
  "verify_commands": ["npm test"]
}
```

当 `decision` 为 `allow` 时，响应会包含结构化的最小调用：

```json
{
  "next_tool_call": {
    "name": "create_task",
    "arguments": {
      "execution_mode": "execute",
      "assessment_id": "assessment_20260622_143000_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
    }
  }
}
```

请原样调用 `next_tool_call`。完整的 128-bit `assessment_id` 用于执行；`assessment_short_id` 仅用于展示。工作区、计划、策略或工具清单变化后会返回 `assessment_stale_*`，此时必须重新 assess。

当 `decision` 为 `needs_confirm` 时，用户需要在使用同一份本地配置的终端运行：

```powershell
patchwarden-confirm assessment_20260622_143000_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6
```

确认入口不属于 MCP 工具，远程调用者不能自行确认。确认后再原样调用返回的 `next_tool_call`；`blocked` 票据不能确认或执行。

### audit_task 结果解释

- `confirmed_failures`：证据已经明确的失败，例如非零测试退出码、越界变更或失败状态。
- `possible_false_positives`：启发式规则可能产生的误报，例如文档属于其他包、构建物是有意跟踪的发布资产。
- `manual_verification_required` / `manual_verification_items`：需要人工或远程权威来源核实的事项。

因此 `verdict: "warn"` 不等于任务一定有错。应先核实上述字段，再决定是否接受结果。

仓库专属验证命令只能配置在本机可信的 `patchwarden.config.json` 中：

```json
{
  "repoAllowedTestCommands": {
    "desktop-app": ["npm run release:check"]
  }
}
```

路径和命令都采用精确匹配，不支持通配符，也不会读取目标仓库的 `package.json` 自动授权。

## English

These conventions reduce connector false positives while preserving local
safety boundaries and complete evidence.

1. Keep one goal per task; separate feature work, expensive builds, and
   Git/release handoff.
2. Use a short English slug for the title.
3. Prefer guarded templates: `inspect_only` for diagnosis, `feature_small` for
   a scoped change, and `fix_tests` for a known failure. Use a long plan only
   when a template cannot express the goal.
4. Prefer assess → execute. Invoke the returned `next_tool_call` unchanged and
   do not resend goal, plan, repository, agent, or verification arguments.
5. Poll long tasks with `list_tasks` and `get_task_status`; inspect
   `get_task_summary(view: "compact")` before full logs or diffs.
6. Run build/package validation separately from source implementation.
7. Changes remain uncommitted for review; commit, push, and publish are outside
   the ordinary task scope.

For routine guarded work, `run_task_loop` can perform the assess-only preflight,
task creation, waiting, safe summary review, audit, and bounded `fix_tests`
follow-up cycle in one tool call. It still uses the existing Watcher and
allow-listed verification commands, stops at local confirmation boundaries, and
returns a `lineage_id` for `get_task_lineage` instead of full logs or diffs.

For v1.4 Direct-assisted verification, set `direct_verify=true` only when the
local Direct profile is enabled and the desired Direct verification commands are
already allow-listed. The loop creates a Direct session after the normal task
and audit have succeeded, runs verification, safe-finalizes, safe-audits, and
stores bounded Direct evidence in lineage. It does not call Direct patching
tools, publish, push, tag, create releases, or restart live services.

For v1.5 isolated loop work, set `agent="auto"` when you want PatchWarden to
pick from configured local agents using bounded routing, and set
`isolation_mode="worktree"` only when the target repo is a git repository and
you want the task to run in an isolated worktree. Worktree mode records evidence
in lineage but never auto-merges or auto-deletes the worktree. After a loop
finishes, call `export_task_evidence_pack(lineage_id)` to write bounded
`evidence.json` and `EVIDENCE.md` files without stdout/stderr tails, full diffs,
verification logs, or sensitive file content.

For v1.3 policy-aware work, call `get_project_policy` before release-oriented
changes. It reads the bounded effective `.patchwarden/project-policy.json`
summary and release readiness without granting new command permissions. Release
mode tools are full-profile only: `release_check` wraps the existing release
gate, `release_prepare` runs only already allow-listed local commands,
`release_verify` performs read-only npm/GitHub/CI checks, and `release_cleanup`
defaults to dry run. None of these tools publish, push, tag, create GitHub
Releases, restart live tunnels/watchers, or return full logs/diffs.

`needs_confirm` assessments must be confirmed locally with
`patchwarden-confirm <full_assessment_id>`. The confirmation command is not an
MCP tool. A `blocked` assessment cannot be confirmed.

In `audit_task`, evidence-backed failures appear in `confirmed_failures`,
heuristic warnings in `possible_false_positives`, and unresolved checks in
`manual_verification_items`. A warning is not automatically a confirmed error.
