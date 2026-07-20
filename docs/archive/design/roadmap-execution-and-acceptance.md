# PatchWarden Roadmap Execution And Acceptance Plan

> Created: 2026-07-09
> Source document: `C:\Users\zengjie\Downloads\PatchWarden_项目推进与外部PR路线图.docx`
> Scope: feasibility check, executable steps, and acceptance commands for PatchWarden-first ecosystem work.

## Conclusion

The roadmap is feasible, but it needs two corrections before execution:

1. `v1.5.1` is not published yet. Local source is `1.5.1`, but GitHub Release and npm `latest` are still `v1.5.0`.
2. Goal Session is not a greenfield feature. PatchWarden already has Goal/Subgoal tools; the next valuable work is final report export, Spec Kit import, and better evidence mapping.

Therefore the execution order should be:

1. P0: close and publish `v1.5.1` safely.
2. P1: finish Evidence Pack v2 and public-facing docs.
3. P2: submit external PRs in low-risk order: MCP Inspector, AgentSeal, then Spec Kit.
4. P3: move to OpenCode/OpenHands/Aider integration docs after PatchWarden has published evidence to point at.

Codex is responsible for implementation submission and acceptance verification. The user only needs to approve destructive, credentialed, or external-write actions when required by local policy.

## Current Verified State

Checked from `D:\ai_agent\Reasonix\reasonix_program\PatchWarden` on 2026-07-09:

- Branch: `codex/patchwarden-v1.5.0`
- HEAD: `cc27e6a Add OSS application evidence materials`
- Worktree: dirty before this plan was added; preserve existing user changes.
- `package.json`: `patchwarden@1.5.1`
- GitHub Release latest: `v1.5.0`
- npm `patchwarden`: `version=1.5.0`, `dist-tags.latest=1.5.0`
- PR #24: open draft, CI passing, branch behind `main`
- Local gates run successfully:
  - `npm.cmd run build`
  - `npm.cmd run test:unit`
  - `npm.cmd run doctor:ci`
  - `npm.cmd run verify:package`

## P0: v1.5.1 Trusted Release

### Objective

Make `v1.5.1` a real published version, not just a local source version.

### Execution

```powershell
git status --short --branch
gh pr view 24 --repo jiezeng2004-design/PatchWarden --json number,title,state,isDraft,mergeStateStatus,headRefName,headRefOid,baseRefName,statusCheckRollup,url
npm.cmd view patchwarden version dist-tags --json --cache "$env:TEMP\patchwarden-npm-cache"
gh release view --repo jiezeng2004-design/PatchWarden --json tagName,name,isDraft,isPrerelease,publishedAt,url
```

If PR #24 is still behind `main`, update the branch without overwriting local work:

```powershell
git fetch origin main
git rebase origin/main
```

If `git fetch` fails with Windows credential errors, stop and repair Git credential/proxy state before retrying. Do not work around it by force-pushing or resetting.

After branch update:

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run test:unit
npm.cmd run test:mcp
npm.cmd run test:http-mcp
npm.cmd run doctor:ci
npm.cmd run verify:package
npm.cmd test
npm.cmd run pack:clean
```

### Submission

Codex owns:

- push updated branch
- mark PR #24 ready for review only after local gates pass
- monitor GitHub Actions
- merge only through PR when checks are green
- create tag and GitHub Release for `v1.5.1`
- publish npm package only after npm auth is confirmed without exposing tokens

### Acceptance

```powershell
gh pr view 24 --repo jiezeng2004-design/PatchWarden --json state,mergeStateStatus,statusCheckRollup
gh release view v1.5.1 --repo jiezeng2004-design/PatchWarden --json tagName,name,isDraft,isPrerelease,publishedAt,url
npm.cmd view patchwarden version dist-tags --json --cache "$env:TEMP\patchwarden-npm-cache"
```

Pass criteria:

- PR merged.
- GitHub Release `v1.5.1` exists and is not draft.
- npm `version` is `1.5.1`.
- npm `dist-tags.latest` is `1.5.1`.
- release notes do not claim anything not verified by CI/GitHub/npm.

## P1: Evidence Pack v2

### Objective

Make Evidence Pack the project signature capability: bounded human summary plus structured machine-readable evidence.

### Current Gap

Current export writes:

- `.patchwarden/evidence-packs/<lineage_id>/evidence.json`
- `.patchwarden/evidence-packs/<lineage_id>/EVIDENCE.md`

The roadmap asks for richer named artifacts:

- `risk.json`
- `verify.json`
- `diffstat.json`
- `lineage.json`
- `attestation.json`
- `redactions.json`

This is feasible as an incremental schema upgrade, not a rewrite.

### Execution

Primary files:

- `src/tools/evidencePack.ts`
- `src/tools/taskLineage.ts`
- `src/tools/registry.ts`
- `src/tools/toolRegistry.ts`
- `src/test/unit/evidence-pack.test.ts` or existing v1.5 evidence tests
- `docs/evidence-pack-schema.md`
- `docs/lineage-evidence-pack-workflow.md`

Implementation rules:

- Keep exports bounded.
- Do not include full stdout, stderr, full diff, secrets, `.env`, tokens, cookies, browser state, or credential paths.
- Store redaction metadata as categories and reasons, not raw hidden values.
- Include PatchWarden version, commit, package version, Node version, OS, tool profile, and schema epoch in attestation.

### Acceptance

```powershell
npm.cmd run build
npm.cmd run test:unit
npm.cmd run doctor:ci
npm.cmd run verify:package
```

Additional manual acceptance:

- Run or reuse a `run_task_loop` lineage.
- Export Evidence Pack.
- Confirm all v2 files exist.
- Confirm `EVIDENCE.md` is readable and bounded.
- Confirm `redactions.json` does not contain raw secrets.
- Confirm no `.patchwarden/evidence-packs` output is included in npm package.

## P1: README And Docs Readiness

### Objective

Make the repository understandable to external users before sending traffic from external PRs.

### Execution

Add or align these docs:

- `docs/why-patchwarden.md`
- `docs/evidence-pack-schema.md`
- `docs/spec-kit-integration.md`
- `docs/agentseal-integration.md`
- `docs/mcp-inspector-testing.md`
- `docs/opencode-worker.md`
- `docs/openhands-worker.md`
- `docs/threat-model.md` already exists; update instead of duplicating.

README front page should preserve these sections:

1. one-line positioning
2. architecture diagram
3. why PatchWarden is not a remote shell
4. five-minute demo
5. Evidence Pack screenshot or text sample
6. supported agents
7. safety boundaries
8. ecosystem adaptation

### Acceptance

```powershell
npm.cmd run build
npm.cmd run check:brand
npm.cmd run doctor:ci
npm.cmd run verify:package
```

Pass criteria:

- README does not say `v1.5.1` is published until npm and GitHub confirm it.
- Docs explain safety boundaries before external integrations.
- Examples use placeholders for published versions unless release truth exists.

## P2: External PR Batch 1

### 1. MCP Inspector

Why first: it is directly relevant, low-risk, and the upstream project is a testing tool for MCP servers.

PR shape:

- `docs: add CLI smoke testing example for MCP servers`
- Generic first; PatchWarden only as one example if appropriate.

Execution:

```powershell
git clone https://github.com/modelcontextprotocol/inspector.git
cd inspector
git checkout -b docs/cli-smoke-testing-example
```

Codex then inspects upstream contribution rules, edits docs only, runs upstream docs/lint/test commands, pushes fork branch, opens PR, and monitors CI.

Acceptance:

- Upstream tests or docs checks pass.
- PR avoids promotional wording.
- PR can stand alone without PatchWarden.

### 2. AgentSeal

Why second: AgentSeal scans dangerous agent skills and MCP configs, which matches PatchWarden policy/config detection.

PR shape:

- `feat: detect PatchWarden MCP configs and project policies`
- or `docs: add guarded local agent execution pattern` if code detector scope is too broad.

Execution:

```powershell
git clone https://github.com/getagentseal/agentseal.git
cd agentseal
git checkout -b detect/patchwarden-policy
```

Codex then inspects `CONTRIBUTING.md`, existing probes, and tests before choosing code or docs scope.

Acceptance:

- Detector recognizes `.patchwarden/config.json` and `project-policy.json` without reading secrets.
- Tests cover positive and negative fixtures.
- PR describes a general safety pattern, not just PatchWarden marketing.

### 3. PatchWarden Compatibility Docs

Why third: after first two external drafts, PatchWarden should document how to reproduce those workflows.

Execution:

```powershell
npm.cmd run build
npm.cmd run doctor:ci
```

Add:

- `docs/mcp-inspector-testing.md`
- `docs/agentseal-integration.md`

Acceptance:

- Commands are runnable on Windows PowerShell.
- Docs link to real upstream PRs or issues after submission.

## P2: External PR Batch 2

### Spec Kit

Why after Evidence Pack v2: Spec Kit is a strong fit, but PatchWarden needs a stable evidence schema before proposing integration.

PR shape:

- `docs: add evidence pack pattern for spec-driven development`
- or `walkthrough: verify implemented tasks with an external MCP safety layer`

Execution:

```powershell
git clone https://github.com/github/spec-kit.git
cd spec-kit
git checkout -b docs/evidence-verification-pattern
```

Acceptance:

- PR maps spec -> tasks -> implementation -> evidence verification.
- PatchWarden appears only as an example implementation.
- Upstream docs checks pass.

## P3: External PR Batch 3

### OpenCode / OpenHands / Aider

These are feasible but should not be first:

- OpenCode has high traffic and a large repo; start with docs-only external supervisor pattern.
- OpenHands is transitioning source ownership; inspect current repo structure before choosing target.
- Aider is mature CLI tooling; a safe wrapper pattern is useful but should follow a published PatchWarden example.

Acceptance for each:

- Upstream contribution rules inspected.
- PR is useful without requiring PatchWarden.
- CI or documented local checks pass.
- PatchWarden README links back only after PR exists.

## Issue Backlog To Create

Create these as GitHub issues after P0 release truth is clean:

1. `fix: close v1.5.1 release truth gap`
2. `feat: add Evidence Pack v2 artifact schema`
3. `docs: add Evidence Pack v2 schema reference`
4. `feat: export goal final report`
5. `feat: import Spec Kit tasks into Goal Session`
6. `docs: add MCP Inspector CLI smoke testing guide`
7. `docs: add AgentSeal compatibility guide`
8. `docs: add OpenCode worker integration guide`
9. `docs: add OpenHands worker integration guide`
10. `docs: add external PR roadmap and ecosystem compatibility matrix`

## Global Acceptance Rules

For every internal PatchWarden PR:

```powershell
npm.cmd run build
npm.cmd run test:unit
npm.cmd run test:mcp
npm.cmd run test:http-mcp
npm.cmd run doctor:ci
npm.cmd run verify:package
```

Before release:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run pack:clean
gh pr checks <PR_NUMBER> --repo jiezeng2004-design/PatchWarden --watch
gh release view v<version> --repo jiezeng2004-design/PatchWarden --json tagName,isDraft,publishedAt,url
npm.cmd view patchwarden version dist-tags --json --cache "$env:TEMP\patchwarden-npm-cache"
```

Never mark release work complete unless GitHub Release and npm registry truth both match the intended version.
