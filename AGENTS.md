# PatchWarden agent rules

PatchWarden is a security-focused local MCP bridge. Preserve workspace confinement, command allow-lists, sensitive-file blocking, explicit agent registration, and auditable task artifacts.

## Commands

Run from this repository in Windows PowerShell with `npm.cmd`:

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd test
npm.cmd run test:mcp
npm.cmd run test:http-mcp
npm.cmd run doctor:ci
npm.cmd run pack:clean
npm.cmd run verify:package
```

Use the narrowest relevant smoke test during iteration, then run the full chain before release or security-sensitive changes.
Use `npm.cmd run doctor` instead of `doctor:ci` when validating a configured local runtime.

## Safety contracts

- Do not expose a general-purpose remote shell or weaken exact command matching.
- Keep all repo paths under configured `workspaceRoot`; block sensitive names and out-of-workspace changes.
- Do not read or persist tokens, cookies, browser state, `.env`, SSH keys, or credential files.
- Do not blanket-kill watchers or tunnels. Only launcher-owned processes may be supervised.
- Keep live tunnel/watcher cutover separate from local code verification; do not restart live services unless explicitly requested.
- Preserve structured task evidence, heartbeat state, before/after Git snapshots, changed-file records, and redaction.

## Changes and release

- Add or update smoke coverage for changed behavior.
- Keep README, examples, tool manifests, package metadata, and migration docs aligned.
- Use branch -> PR -> CI -> merge. Publishing is manual and must separately verify GitHub Release, `patchwarden` on npm, and `dist-tags.latest`.
- The pre-rename npm package is frozen; do not publish new versions under the legacy name.

## Codex Memory

本项目的长期记忆库位于：

`D:\ai_agent\CodexMemory`

处理复杂任务前请先阅读：

- `D:\ai_agent\CodexMemory\04_Index\00_INDEX.md`
- `D:\ai_agent\CodexMemory\00_Workspace\CURRENT.md`
- `D:\ai_agent\CodexMemory\03_Permanent\Projects\PatchWarden.md`

如果本次任务产生长期有效结论，请更新对应项目记忆。
如果本次任务出现可复用修复经验，请记录到 Bugs_and_Fixes。
如果本次任务出现失败尝试，请记录到 Failed_Attempts。
如果本次任务形成稳定部署流程，请记录到 Runbooks。
禁止记录真实 API Key、Token、Cookie、密码、私钥。
