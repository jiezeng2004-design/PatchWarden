# Safe-Bifrost

Safe-Bifrost is a local Model Context Protocol (MCP) server for a safe
plan-and-execute workflow:

1. An MCP client saves an implementation plan.
2. Safe-Bifrost stores the plan inside one configured workspace.
3. A local runner executes the task with an allow-listed local agent command.
4. The client reads back the result, git diff, test log, and task status.

It is designed for local AI coding workflows where ChatGPT, Claude, Codex,
OpenCode, or another MCP client should not receive arbitrary shell access.

## Features

- MCP stdio server with 9 tools.
- Workspace-scoped plan and task storage under `.safe-bifrost/`.
- Path traversal and symlink containment checks.
- Sensitive file read blocking for `.env`, SSH keys, tokens, credentials,
  browser cookies, npm credentials, Kubernetes config, and similar files.
- Agent command allow-list through `safe-bifrost.config.json`.
- Test command allow-list with exact command matching.
- Local runner that captures `result.md`, `git.diff`, and `test.log`.
- Windows-friendly Node.js scripts.

## Tools

Safe-Bifrost exposes these MCP tools:

- `save_plan`
- `get_plan`
- `create_task`
- `get_task_status`
- `get_result`
- `get_diff`
- `get_test_log`
- `list_workspace`
- `read_workspace_file`

## Requirements

- Node.js 18 or newer.
- npm for local development.
- A local agent command if you want runner execution, such as `codex` or
  `opencode`.

## Install From Source

Windows PowerShell:

```powershell
cd D:\ai_agent\Reasonix\reasonix_program\safe-bifrost
npm.cmd install
npm.cmd run build
npm.cmd run test:mcp
```

Linux, WSL, or Git Bash:

```bash
cd safe-bifrost
npm install
npm run build
npm run test:mcp
```

## Configure

Create `safe-bifrost.config.json`. Save it as UTF-8. The server also accepts
UTF-8 with BOM, but UTF-8 without BOM is recommended for portability.

```json
{
  "workspaceRoot": "D:/ai_agent/my-project",
  "plansDir": ".safe-bifrost/plans",
  "tasksDir": ".safe-bifrost/tasks",
  "agents": {
    "codex": {
      "command": "codex",
      "args": ["exec", "--cd", "{repo}", "{prompt}"]
    },
    "opencode": {
      "command": "opencode",
      "args": ["run", "{prompt}"]
    }
  },
  "allowedTestCommands": [
    "npm test",
    "npm run test",
    "pytest",
    "cargo test"
  ],
  "maxReadFileBytes": 200000
}
```

Important fields:

- `workspaceRoot`: absolute path to the workspace that Safe-Bifrost may read
  and write.
- `plansDir`: plan storage directory, relative to `workspaceRoot`.
- `tasksDir`: task storage directory, relative to `workspaceRoot`.
- `agents`: allow-listed local agent commands. The `{repo}` and `{prompt}`
  placeholders are replaced by the runner and passed as process arguments.
- `allowedTestCommands`: exact test commands that clients may request.
- `maxReadFileBytes`: maximum bytes returned by file-reading tools.

## Run The MCP Server

Windows PowerShell:

```powershell
$env:SAFE_BIFROST_CONFIG = "D:\ai_agent\Reasonix\reasonix_program\safe-bifrost\safe-bifrost.config.json"
node dist\index.js
```

Linux, WSL, or Git Bash:

```bash
SAFE_BIFROST_CONFIG=/path/to/safe-bifrost.config.json node dist/index.js
```

## MCP Client Configuration

Use an absolute path for both the server entrypoint and config file.

```json
{
  "mcpServers": {
    "safe-bifrost": {
      "command": "node",
      "args": [
        "D:/ai_agent/Reasonix/reasonix_program/safe-bifrost/dist/index.js"
      ],
      "env": {
        "SAFE_BIFROST_CONFIG": "D:/ai_agent/Reasonix/reasonix_program/safe-bifrost/safe-bifrost.config.json"
      }
    }
  }
}
```

## Workflow

1. Call `save_plan` with a title and Markdown plan.
2. Call `create_task` with the returned `plan_id`, an allow-listed `agent`, and
   optionally an allow-listed `test_command`.
3. Run the task locally:

   ```powershell
   npm.cmd run runner -- task_xxx
   ```

4. Call `get_result`, `get_diff`, and `get_test_log` to review outputs.

## Security Model

Safe-Bifrost intentionally avoids general shell execution through MCP tools.

- Clients cannot pass arbitrary shell commands.
- Agent commands must be configured ahead of time.
- Test commands must match `allowedTestCommands` exactly.
- File reads are contained to `workspaceRoot`.
- Sensitive files are blocked even when they are inside the workspace.
- The runner does not commit, push, delete files, or reset repositories by
  itself.

This project is still a local automation bridge, so configure `workspaceRoot`
and `agents` carefully.

## Development Commands

Windows PowerShell:

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run test:mcp
npm.cmd run verify:package
npm.cmd run pack:clean
```

`test:mcp` starts the MCP server over stdio, calls the real tools, verifies
security rejections, and runs the local runner with a harmless placeholder
agent command.

## Release Artifacts

Generate a clean source/dist archive:

```powershell
npm.cmd run pack:clean
```

Generate the npm package tarball:

```powershell
npm.cmd pack
```

The clean release archive excludes `node_modules/`, `.safe-bifrost/`, logs,
local config files, and `.env`.

## License

MIT
