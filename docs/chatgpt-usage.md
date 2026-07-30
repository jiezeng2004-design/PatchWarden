# ChatGPT 调用规范 / ChatGPT usage guide

## 中文

这套约定用于降低长参数、长轮询、构建产物和完整日志触发连接器误拦截的概率，同时保留 PatchWarden 的本地安全边界和完整证据。

1. 一个任务只处理一个目标；功能实现、耗时构建和 Git/发布收尾分开执行。
2. 计划标题使用短英文 slug，详细说明放在目标或计划正文中。
3. ChatGPT 优先使用守护模板：只读诊断用 `inspect_only`，小范围修改用 `feature_small`，修复已知失败用 `fix_tests`。模板不够表达目标时才使用 `inline_plan` 或保存的长计划。
4. 创建任务时优先采用 assess → execute 两步流程。execute 必须直接使用 assess 返回的 `next_tool_call`，不要重复发送 goal、plan、repo、agent 或验证命令。
5. 短任务可以调用 `wait_for_task(timeout_seconds: 25)`；长任务使用 `list_tasks(repo_path=..., active_only=true)` 和 `get_task_status`。
6. 终态先读取 `get_task_summary(view: "compact")` 和 `audit_task`；证据不足时才读取 standard 摘要、完整 diff 或日志。
7. 构建验证与源码任务分开。`artifact_hygiene` 统一提供 `source_changes`、`dependency_changes`、`generated_changes`、`runtime_changes` 和 `unexpected_changes`；旧的构建物字段继续兼容。默认识别 `.next`、`dist`、`build`、`coverage`、`*.tsbuildinfo` 等路径，并合并安全的 ignore 规则与本地 `generatedPaths` 配置。已跟踪或未忽略的生成物仍进入 `unexpected_changes`，不会被静默忽略。
8. 网页项目需要运行态验收时，在本地配置中启用 `runtimeValidation`。启动命令必须已进入仓库验证白名单，URL 必须是字面量 loopback；PatchWarden 不会附着到已占用端口。结果在 `runtime-validation.json`，截图在任务目录的 `runtime-screenshots/`，最终摘要只返回有界计数。
9. 查看 `completion` 分层状态：实现、静态验证、运行态验证、人工复核和用户验收彼此独立。`done_by_agent` 只说明 Agent 进程结束；当运行态证据缺失时必须保持 `manual_review_required=true`。
10. 优先读取 `acceptance-report.json` 的低噪声结论，再按需展开 `project-facts-validation.json`、`framework-validation.json`、`svg-xml-validation.json` 和 `document-command-evidence.json`。文档中的叙述示例不会因脚本不存在而阻断，但代码块、行内命令和 shell 行会保留来源证据。
11. 连接器重试必须复用稳定的 `request_id`。完全相同的请求可安全复用；若受锁定参数变化，PatchWarden 返回 `request_id_parameter_mismatch`。不要因 connector/Watcher 故障切换 Agent，也不要把这类故障计入 Agent retry。
12. PatchWarden 保留未提交改动供人工审核；提交、推送和发布不属于普通任务范围。

### 项目事实与框架覆盖

可在仓库根目录新建 `.patchwarden/project-facts.json`（推荐）或 `PROJECT_FACTS.json`。该文件只应写入已核实事实，可包含 `contacts`、`domains`、`quantitative_claims`、`adoption_claims`、`licenses` 和 `prohibited_claims`。不要把 token、Cookie、密码或其他凭据写入事实文件。

PatchWarden 会根据仓库文件识别 Next.js、Node.js、Python、Rust 和 Electron，并运行对应的结构化检查；无法可靠识别时回退到 generic 验证。SVG/XML 使用真实解析器，错误包含文件、行、列和原因。所有覆盖文件都是审计证据，不替代仓库真实的测试、构建或人工视觉验收。

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

For routine guarded work, `run_task_loop` starts the assess-only preflight,
task creation, safe summary review, audit, and bounded `fix_tests` follow-up
cycle. By default it returns `request_id`, `lineage_id`, and the main `task_id`
as soon as the task is created while Core continues the loop. Call
`wait_for_task(task_id)` and then `get_task_lineage(lineage_id)` instead of
holding the transport open. Reuse the same `request_id` with identical inputs
on retry; PatchWarden returns the existing lineage instead of creating a
duplicate. `wait_for_completion=true` is a local/debug compatibility option.
The loop still uses the existing Watcher and allow-listed verification commands,
stops at local confirmation boundaries, and never returns full logs or diffs.

For v1.4 Direct-assisted verification, set `direct_verify=true` only when the
local Direct profile is enabled and the desired Direct verification commands are
already allow-listed. The loop creates a Direct session after the normal task
and audit have succeeded, runs verification, safe-finalizes, safe-audits, and
stores bounded Direct evidence in lineage. It does not call Direct patching
tools, publish, push, tag, create releases, or restart live services.
These verification-only Direct sessions set `expected_changes=false`, so an
empty diff is expected and does not produce an `empty_diff` audit warning.
Clients creating their own read-only Direct session should pass the same flag;
editing sessions keep the default `expected_changes=true` behavior.

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

## Task model and idempotency parameters

Pass `requested_model` only with an explicit Agent, for example `{"agent":"opencode","requested_model":"agnes/agnes-2.0-flash"}`. Do not combine it with an omitted Agent or `agent="auto"`. The assess-only snapshot locks the model, and every repair/retry round inherits it unchanged. No model fallback is performed.

OpenCode inherit-mode tasks use the user's normal XDG configuration source.
The private `XDG_CONFIG_HOME` used to supervise the Watcher is removed or
replaced before OpenCode starts, so custom providers such as relay-backed
models remain available without copying provider credentials into PatchWarden.

Use a stable `request_id` when a connector may retry `create_task` or `run_task_loop`. Identical parameters reuse the existing result. If any locked parameter changes, the call fails with `request_id_parameter_mismatch`; `changed_fields` identifies names such as `requested_model` without exposing values.
