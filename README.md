# Safe-Bifrost

Current release: **v0.3.0**. See [v0.3.0 release notes](docs/release-v0.3.0.md).

Safe-Bifrost is a local Model Context Protocol (MCP) bridge for safe
plan-and-execute coding workflows.

It lets ChatGPT, Codex, Claude, or another MCP client save a plan, create a
workspace-scoped task, let a local agent execute it, and then read back the
result, git diff, test log, and task status.

![Safe-Bifrost ChatGPT connector demo](docs/assets/safe-bifrost-chatgpt-demo.svg)

## Why

Many local coding bridges give the upstream model broad shell access.
Safe-Bifrost takes a narrower route:

```text
ChatGPT Web or another MCP client
-> Safe-Bifrost MCP tools
-> save_plan / create_task
-> watcher finds pending tasks
-> local agent executes
-> result.md / result.json / diff.patch / verify.json / status.json
-> client reviews the result
```

The MCP client can plan and review, but it does not receive a general shell
tool.

## Features

- MCP stdio server with workspace-scoped tools.
- Optional HTTP MCP server bound to `127.0.0.1`.
- ChatGPT Connector / OpenAI Secure MCP Tunnel workflow.
- Automatic watcher for pending tasks.
- Local runner that captures `result.md`, `git.diff`, `test.log`, and
  `status.json`.
- Task phases, heartbeat timestamps, progress reports, cancellation, forced
  termination, and bounded task timeouts.
- Server-side `wait_for_task` long polling so ChatGPT can remain in one tool
  loop until the agent reaches a terminal state.
- Structured `result.json`, `verify.json`, `diff.patch`, and
  `get_task_summary` acceptance evidence.
- Workspace-wide before/after fingerprints that fail a task when changes are
  detected outside its explicit `repo_path`.
- Before/after file fingerprints for stronger change evidence.
- File reads contained to one configured `workspaceRoot`.
- Sensitive file blocking for `.env`, tokens, SSH keys, credentials, cookies,
  and similar paths.
- Low-risk plan storage: ordinary build/test/release language is accepted;
  explicit credential theft, destructive disk deletion, and backdoor plans are blocked.
- Task artifacts are returned with secret-like values redacted instead of
  failing the entire read.
- Agent command allowlist through `safe-bifrost.config.json`.
- Test command exact-match allowlist.
- Windows-friendly helper scripts.
- Read-only `doctor` command for local setup diagnostics.

## MCP Tools

Safe-Bifrost exposes these tools:

- `list_workspace`
- `read_workspace_file`
- `save_plan`
- `get_plan`
- `health_check`
- `list_agents`
- `create_task`
- `get_task_status`
- `get_result`
- `get_result_json`
- `get_diff`
- `get_test_log`
- `list_tasks`
- `cancel_task`
- `kill_task`
- `retry_task`
- `get_task_progress`
- `wait_for_task`
- `get_task_summary`
- `get_task_stdout_tail`
- `audit_task`

## Install

Requirements:

- Node.js 18 or newer
- npm
- Git, if you want `git.diff`
- A configured local coding agent such as `opencode` or `codex`

Windows PowerShell:

```powershell
cd path\to\safe-bifrost
npm.cmd ci
npm.cmd run build
npm.cmd test
```

Linux, macOS, or WSL:

```bash
cd safe-bifrost
npm ci
npm run build
npm test
```

## Configure

Create `safe-bifrost.config.json` in the project root. Do not commit this
file.

```json
{
  "workspaceRoot": "D:/path/to/test-or-project-workspace",
  "plansDir": ".safe-bifrost/plans",
  "tasksDir": ".safe-bifrost/tasks",
  "agents": {
    "opencode": {
      "command": "opencode",
      "args": ["run", "{prompt}"]
    }
  },
  "allowedTestCommands": [
    "npm test",
    "npm run lint",
    "npm run format:check",
    "npm run build",
    "npm run dist",
    "npm run doctor"
  ],
  "maxReadFileBytes": 200000,
  "defaultTaskTimeoutSeconds": 900,
  "maxTaskTimeoutSeconds": 3600,
  "httpPort": 7331
}
```

Important rules:

- Use a small project directory for `workspaceRoot`.
- Do not set `workspaceRoot` to a drive root, home directory, Desktop,
  Downloads, or Documents.
- Do not place secrets inside the workspace.
- Keep agent commands and test commands narrow.

## Run Locally

Build first:

```powershell
npm.cmd run build
```

Run the stdio MCP server:

```powershell
$env:SAFE_BIFROST_CONFIG = "path\to\safe-bifrost.config.json"
node dist\index.js
```

Run the watcher in another terminal:

```powershell
$env:SAFE_BIFROST_CONFIG = "path\to\safe-bifrost.config.json"
npm.cmd run watch
```

Run the HTTP MCP server for local tunnel mode:

```powershell
$env:SAFE_BIFROST_CONFIG = "path\to\safe-bifrost.config.json"
npm.cmd run start:http
```

The HTTP server binds only to `127.0.0.1`.

## ChatGPT Connector

The intended ChatGPT flow is:

```text
ChatGPT Web
-> ChatGPT Connector
-> OpenAI Secure MCP Tunnel
-> Safe-Bifrost MCP server
-> watcher
-> local agent
```

For stdio tunnel mode on Windows, use the launcher:

```text
scripts/safe-bifrost-mcp-stdio.cmd
```

This wrapper sets `SAFE_BIFROST_CONFIG`, changes into the Safe-Bifrost project
root, and starts `node dist/index.js`. It prevents tunnel-client from using
the tunnel-client directory as the MCP workspace.

### One-Click Windows Launcher

For local development, run:

```text
Start-SafeBifrost-Tunnel.cmd
```

The launcher:

- asks for your tunnel runtime API key on first use, then stores it encrypted
  with Windows DPAPI under `%APPDATA%\safe-bifrost`
- asks for a tunnel ID if `SAFE_BIFROST_TUNNEL_ID` is not already set
- starts the watcher in a separate PowerShell window
- runs `tunnel-client doctor`
- starts `tunnel-client run`

Optional environment variables:

```powershell
$env:SAFE_BIFROST_TUNNEL_ID = "tunnel_xxx"
$env:TUNNEL_CLIENT_EXE = "C:\path\to\tunnel-client.exe"
$env:OPENCODE_BIN_DIR = "C:\path\to\opencode-ai\bin"
$env:HTTPS_PROXY = "http://127.0.0.1:7892"
$env:SAFE_BIFROST_CREDENTIAL_PATH = "C:\private\safe-bifrost-key.dpapi"
```

The saved key is bound to the current Windows user and computer. It is never
written to the repository or printed to logs. To remove it, run
`Reset-SafeBifrost-Tunnel-Key.cmd`.

Never commit API keys, runtime keys, tunnel IDs, local account names, or
private workspace IDs.

## Demo

See [docs/demo.md](docs/demo.md) for a privacy-safe ChatGPT connector demo and
expected outputs.

## Troubleshooting

### ChatGPT lists the tunnel-client directory

If `list_workspace` returns only `tunnel-client.exe`, the MCP child process did
not receive `SAFE_BIFROST_CONFIG` or started from the wrong working directory.

Fix: use `scripts/safe-bifrost-mcp-stdio.cmd` as the tunnel MCP command, then
restart tunnel-client.

### ChatGPT tool call times out

Check the tunnel-client UI at:

```text
http://127.0.0.1:8080/ui
```

If logs show:

```text
unsupported_country_region_territory
403 Forbidden
```

then the current proxy exit region is not supported by the OpenAI API control
plane. Change to a supported region and restart tunnel-client.

### ChatGPT stops after `create_task`

An MCP server cannot send a new message into ChatGPT after the assistant turn
has ended. Do not rely on a prompt that says only "wait and check later".
Immediately call `wait_for_task` after `create_task`. If its response contains
`continuation_required: true`, call it again in the same assistant turn. When
`terminal: true`, use the included summary and then call `audit_task` for the
independent review. Each wait is capped at 30 seconds to stay below common
connector and tunnel request timeouts.

If logs show direct connection timeouts to `api.openai.com`, set a proxy:

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7892"
```

### ChatGPT Connector creation fails

Verify:

- tunnel-client is running
- the tunnel is associated with the correct ChatGPT workspace
- the connector uses `Channel`, not `Server URL`
- authentication is set to `None` unless you have implemented OAuth
- browser translation extensions are disabled on Platform pages

## Recommended Workflow

Start with `health_check` and `list_agents`. `create_task` requires an explicit
`repo_path`; it never silently falls back to the workspace root. Prefer
`verify_commands` from the exact schema allowlist. Immediately enter the
`wait_for_task` loop and keep calling it while `continuation_required` is true.
Use `cancel_task` for graceful cancellation or `kill_task` for immediate
termination. Final acceptance starts with `get_task_summary`, followed by
`audit_task` and any detailed artifacts needed for review.

Do not use the entire `workspaceRoot` as the task repository unless that is
truly the intended repository. Prefer a relative subdirectory such as
`desktop-pet-wangzai`; absolute paths are also accepted when they resolve
inside `workspaceRoot`.

Recommended `create_task` arguments (add the `plan_id` returned by
`save_plan`):

```json
{
  "agent": "opencode",
  "repo_path": "desktop-pet-wangzai",
  "verify_commands": [
    "npm run lint",
    "npm run format:check",
    "npm test",
    "npm run dist"
  ]
}
```

1. `list_workspace` — explore the project
2. `save_plan` — ChatGPT writes the implementation plan
3. `create_task` with `repo_path` and `verify_commands`
4. `wait_for_task` — repeat in the same turn until `terminal: true`
5. `get_task_summary` — inspect scope, verification, files, and artifacts
6. `get_result_json` / `get_diff` / `get_test_log` — inspect detailed evidence
7. `audit_task` — independent verification (checks claims vs reality)

> **Important:**
> - `task done` means the agent finished executing — it does NOT mean the work is correct or complete.
> - `failed_scope_violation` takes precedence over acceptance. Review
>   `rollback_scope_violation_plan.md`; Safe-Bifrost never auto-rolls back concurrent/user edits.
> - `failed_verification` means at least one independent allow-listed command failed;
>   inspect `verify.log` before retrying.
> - `audit_task` provides an independent review, but still requires human judgment.
> - Local `result.md` claims about `npm publish`, `git push`, or `GitHub release` are **unverified**.
> - Publishing, tagging, pushing, and npm publish must be confirmed manually.
> - Before running `doctor`, create `safe-bifrost.config.json` from the example template.

### Task artifacts

- `result.md`: human-readable execution report and agent output.
- `result.json`: structured status, paths, changed files, scope evidence,
  verification state, warnings, errors, and next steps for tools.
- `verify.json`: one structured record per independently executed allow-listed
  verification command, including cwd, exit code, output tails, and timing.
- `verify.log`: readable form of the same independent verification evidence.
- `diff.patch`: full textual patch captured after the task; `get_diff` truncates
  only its response when necessary and returns `diff_patch_path` plus file stats.
- `rollback_scope_violation_plan.md`: review-only list of repo-external changes;
  it never includes normal in-repo changes and never performs rollback itself.

## Security Model

Safe-Bifrost intentionally avoids general shell execution through MCP tools.

- MCP clients cannot pass arbitrary shell commands.
- Agent commands must be configured ahead of time.
- Test commands must match `allowedTestCommands` exactly.
- File reads are contained to `workspaceRoot`.
- Sensitive file names are blocked even inside the workspace.
- The runner does not commit, push, delete files, or reset repositories.
- HTTP mode binds to `127.0.0.1` only.

This is still a local automation bridge. Treat connector access as powerful
and use a dedicated test workspace first.

## Development

Windows PowerShell:

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run test:mcp
npm.cmd run test:http-mcp
npm.cmd run doctor
npm.cmd run pack:clean
```

Package checks:

```powershell
npm.cmd run verify:package
npm.cmd run pack:clean
```

The clean archive excludes:

- `node_modules/`
- `.safe-bifrost/`
- `*.log`
- `.env`
- `safe-bifrost.config.json`
- local release artifacts

## Roadmap

- [x] stdio MCP server
- [x] plan and task CRUD
- [x] runner and watcher
- [x] HTTP MCP server
- [x] ChatGPT Connector tunnel docs
- [x] doctor command
- [ ] worktree isolation
- [ ] multi-agent task queue
- [ ] dashboard

## License

MIT
