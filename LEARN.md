# Learn: Build a safer local-agent workflow with PatchWarden

PatchWarden is a local-first MCP safety and verification layer for AI coding
agents. This guide explains how the project was built and how you can recreate
the main ideas in a learning environment.

By the end, you should understand how to design a bridge where an AI client can
request coding work without receiving unrestricted shell access.

## Who this is for

- Students learning about AI developer tools, Model Context Protocol (MCP), or
  local automation safety.
- Developers who want to connect ChatGPT, Codex, OpenCode, or another MCP
  client to a local repository with guardrails.
- Maintainers who want auditable task records before accepting AI-generated
  changes.

Estimated time: 45 to 90 minutes for the walkthrough, longer if you connect a
real local coding agent.

## What you will learn

- Why unrestricted local shell access is risky for AI coding workflows.
- How PatchWarden separates planning, execution, verification, and human review.
- How workspace confinement, command allowlists, and sensitive-path blocking
  reduce accidental damage.
- How task artifacts such as `result.json`, `diff.patch`, and `verify.json`
  make AI-assisted work easier to audit.
- How to validate a local Node.js TypeScript project before sharing it.

## Project idea

Many AI coding tools can edit files and run commands. That is powerful, but it
also creates risks:

- The model may touch files outside the intended repository.
- A broad shell interface may run commands the maintainer did not expect.
- Sensitive files such as `.env`, SSH keys, cookies, or tokens may be exposed.
- A successful-looking answer may not include independent verification.

PatchWarden was built around a narrower pattern:

```text
MCP client plans the task
        |
        v
PatchWarden stores a bounded task
        |
        v
Preconfigured local agent executes it
        |
        v
PatchWarden records diffs, results, and verification evidence
        |
        v
Human reviews before committing or publishing
```

The important design choice is that the upstream MCP client does not receive a
general-purpose remote shell. It can only use explicit PatchWarden tools and
local policy.

## Prerequisites

- Node.js 18 or newer.
- npm.
- Git.
- Windows PowerShell for the commands below.
- Optional: a local coding agent such as OpenCode or Codex CLI.

Check your tools:

```powershell
node -v
npm.cmd -v
git --version
```

If you are on macOS or Linux, use `npm` instead of `npm.cmd` and adapt the path
examples.

## Step 1: Clone and inspect the project

```powershell
git clone https://github.com/jiezeng2004-design/PatchWarden.git
cd .\PatchWarden
```

Before running anything, inspect the project files:

```powershell
Get-ChildItem
Get-Content .\package.json
Get-Content .\README.en.md -TotalCount 80
```

Key files and folders:

| Path | Purpose |
| --- | --- |
| `src/` | TypeScript source code for the MCP server, runner, tools, and checks. |
| `examples/config.example.json` | Starting point for local configuration. |
| `docs/` | Usage notes, release checks, migration notes, and demo material. |
| `scripts/checks/` | Smoke tests and safety checks. |
| `README.md` / `README.en.md` | Full user documentation. |
| `AGENTS.md` | Maintainer rules for safe AI-assisted work on this repository. |

## Step 2: Install dependencies and build

```powershell
npm.cmd ci
npm.cmd run build
```

This compiles the TypeScript source into `dist/`. The generated `dist/` folder
is used by runtime commands and smoke tests.

## Step 3: Create a local configuration

PatchWarden needs a configuration file, but real configuration may contain
private local paths and agent commands. Start from the example:

```powershell
Copy-Item .\examples\config.example.json .\patchwarden.config.json
```

Open `patchwarden.config.json` and set at least:

- `workspaceRoot`: the only workspace PatchWarden may access.
- `agents`: the local execution agents that PatchWarden is allowed to launch.
- `allowedTestCommands`: exact verification commands that may be run.

Use a dedicated test workspace first. Do not point `workspaceRoot` at your whole
drive, home directory, Desktop, Downloads, or Documents folder.

Example policy idea:

```json
{
  "workspaceRoot": "D:/ai_agent/codex_program",
  "allowedTestCommands": [
    "npm test",
    "npm run build"
  ]
}
```

Do not commit your real `patchwarden.config.json`. It may contain private paths,
agent names, and local workflow details.

## Step 4: Run diagnostics

Set the configuration path for the current PowerShell session:

```powershell
$env:PATCHWARDEN_CONFIG = (Resolve-Path .\patchwarden.config.json)
npm.cmd run doctor
```

The doctor command checks the local environment, configuration, workspace
containment, sensitive-path protection, agent commands, tool manifest, task
directories, and build output.

If diagnostics fail, fix the first real error before continuing. Common issues
are a missing agent command, a workspace path that is too broad, or a
verification command that does not exactly match the allowlist.

## Step 5: Understand the task workflow

A normal PatchWarden task follows this sequence:

1. Check health and tool availability.
2. Confirm the configured local agent exists.
3. Choose a repository inside `workspaceRoot`.
4. Save a plan or provide an inline plan.
5. Create a task with an agent, repository path, and verification commands.
6. Let the Watcher launch the preconfigured local agent.
7. Review `result.json`, `diff.patch`, `verify.json`, and task status.
8. Let a human decide whether to accept, commit, or publish.

This is the core learning pattern: AI can help plan and execute, but policy and
review stay local and explicit.

## Step 6: Start the Watcher

The Watcher is the process that finds pending tasks and launches the configured
local agent.

```powershell
$env:PATCHWARDEN_CONFIG = (Resolve-Path .\patchwarden.config.json)
npm.cmd run watch
```

Keep this terminal open while testing task execution. If the Watcher is not
running, a task may be saved but remain queued.

## Step 7: Review task evidence

Completed tasks write evidence under the configured task directory, usually:

```text
.patchwarden/tasks/<task_id>/
```

Useful files include:

| File | What to inspect |
| --- | --- |
| `status.json` | Current task state. |
| `result.json` | Final result, warnings, changed-file groups, and verification status. |
| `diff.patch` | Complete Git diff when available. |
| `verify.json` | Exact verification commands and exit codes. |
| `artifact_manifest.json` | Generated artifacts, sizes, and hashes. |

This evidence is the main difference between "the AI said it worked" and "the
project has reviewable proof."

## Step 8: Run project verification

For local development, run:

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run test:mcp
npm.cmd run test:http-mcp
npm.cmd run doctor
```

Before publishing a release, also run the package checks documented in the
README:

```powershell
npm.cmd run pack:clean
npm.cmd run verify:package
```

Local tests do not prove that GitHub Releases or npm publication succeeded.
Always verify remote tags, release assets, npm package versions, and checksums
separately.

## Safety checklist

Before using PatchWarden on a real project, confirm:

- `workspaceRoot` points to a dedicated workspace, not a broad personal folder.
- Each `repo_path` stays inside `workspaceRoot`.
- Local agents are registered in configuration, not supplied by model input.
- Verification commands exactly match `allowedTestCommands`.
- `.env`, tokens, keys, cookies, and credential files are not read or committed.
- The Runner does not automatically commit, push, publish, or reset.
- A human reviews the diff and verification evidence.

## Suggested learning exercises

1. Read `examples/config.example.json` and identify every setting that limits
   what the agent can do.
2. Add a harmless test repository inside your workspace and configure one exact
   verification command for it.
3. Run `npm.cmd run doctor` with an intentionally invalid command allowlist,
   then fix the error.
4. Inspect a completed task folder and explain the purpose of each evidence
   file.
5. Compare a broad shell-based automation design with PatchWarden's bounded
   task design. List what each approach makes easier and riskier.

## Reflection questions

- What should an AI client be allowed to decide, and what should remain local
  policy?
- Why is exact command matching safer than "similar command" matching?
- What evidence would you require before accepting an AI-generated change?
- Which files should never appear in a public demo, package, or screenshot?
- How would you adapt this design for a classroom team project?

## Troubleshooting

| Symptom | Likely cause | First check |
| --- | --- | --- |
| `npm.cmd run build` fails | Dependencies missing or TypeScript error | Run `npm.cmd ci`, then read the first compiler error. |
| `doctor` rejects configuration | Path, agent, or allowlist problem | Check `patchwarden.config.json` and use narrow workspace paths. |
| Task stays queued | Watcher is not running | Start `npm.cmd run watch` with `PATCHWARDEN_CONFIG` set. |
| Verification command is rejected | Command does not exactly match the allowlist | Copy the exact command into `allowedTestCommands`. |
| Agent command not found | Agent is not installed or not on PATH | Run `where.exe <agent-command>`. |

## Next steps

- Read `README.en.md` for the complete setup guide.
- Read `docs/demo.md` for a shorter project demonstration.
- Read `docs/release-checklist.md` before publishing a package or release.
- Explore `scripts/checks/` to see how the project verifies safety behavior.

PatchWarden is intentionally conservative. The goal is not to remove human
judgment from software work, but to make AI-assisted changes easier to bound,
verify, and review.
