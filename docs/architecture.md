# PatchWarden Architecture

PatchWarden is designed as a narrow control layer between an MCP client and
local coding agents.

## Roles

```text
ChatGPT / Codex / OpenCode / another MCP client
                    |
                    v
          PatchWarden MCP Server
                    |
          save_plan / create_task
                    |
                    v
       .patchwarden/tasks/<task_id>/
                    |
              Watcher finds task
                    |
                    v
       Local agent (OpenCode / Codex)
                    |
                    v
 result.json / diff.patch / verify.json / status.json
                    |
                    v
       MCP client reads safe summaries and audit evidence
```

## Core Components

| Component | Responsibility |
| --- | --- |
| MCP server | Exposes constrained planning, task, summary, audit, and status tools. |
| Watcher | Polls queued tasks and starts preconfigured local agents. |
| Agent registry | Defines trusted agent commands and argument templates. |
| Command guard | Allows only exact verification commands from trusted configuration. |
| Path guard | Keeps task paths under `workspaceRoot` and reports out-of-scope changes. |
| Sensitive path guard | Blocks known credential and private-data file names. |
| Evidence writer | Records status, result, verification, changed files, and audit artifacts. |
| Control Center | Provides safe-first local review pages for tasks, direct sessions, lineage, warnings, and evidence packs. |

## Data Flow

1. A client saves a plan or creates a task with an explicit `repo_path`.
2. PatchWarden validates the repository path and requested verification
   commands.
3. The task is written under `.patchwarden/tasks/<task_id>/`.
4. The Watcher starts the selected registered agent.
5. PatchWarden captures task status, changed files, Git diff evidence where
   available, verification output, and audit summaries.
6. The client reviews safe summaries first and asks for deeper artifacts only
   when needed.

## Safety Design

PatchWarden treats model instructions as untrusted input. The local maintainer
controls the workspace root, allowed commands, registered agents, and release
process. The project intentionally keeps push, publish, tag, GitHub Release,
and live service changes outside ordinary task execution.

For the security model, see `docs/threat-model.md`.
