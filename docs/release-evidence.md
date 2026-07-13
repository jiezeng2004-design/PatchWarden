# PatchWarden Release Evidence

This file separates local source state from public release truth. Update it
before submitting external applications or publishing a release.

## Current Snapshot

Checked on 2026-07-12 from the PatchWarden workspace.

| Surface | Current evidence |
| --- | --- |
| Local branch | `codex/evidence-pack-v2` |
| Local `package.json` | `patchwarden@1.5.1` |
| GitHub latest release | `v1.5.0` |
| GitHub release URL | https://github.com/jiezeng2004-design/PatchWarden/releases/tag/v1.5.0 |
| GitHub release published at | 2026-07-07T11:36:48Z |
| npm latest | `patchwarden@1.5.0` |
| npm `dist-tags.latest` | `1.5.0` |
| GitHub stars | 2 |
| GitHub forks | 0 |
| Open issues | 9 (`#25`, `#26`, `#28`–`#34`) |
| Open pull requests | 2 (`#24`, `#37`, both draft) |

Conclusion: `1.5.0` is the latest verified public release. The local `1.5.1`
source state is ahead of the public release and should be treated as pending
until PR, CI, GitHub Release, npm, and `dist-tags.latest` are all verified.

## Commands Used

Windows PowerShell:

```powershell
gh repo view jiezeng2004-design/PatchWarden --json nameWithOwner,stargazerCount,forkCount,issues,pullRequests,defaultBranchRef,pushedAt,url,description,licenseInfo,repositoryTopics,latestRelease,hasDiscussionsEnabled,hasIssuesEnabled,securityPolicyUrl
gh release view v1.5.1 --repo jiezeng2004-design/PatchWarden --json tagName,name,publishedAt,isDraft,isPrerelease,url
gh release view --repo jiezeng2004-design/PatchWarden --json tagName,name,publishedAt,isDraft,isPrerelease,url
npm.cmd view patchwarden version dist-tags --json --cache .\.npm-cache
```

The npm query succeeded on 2026-07-12 with the repository-local `.npm-cache`:
`version=1.5.0`, `dist-tags.latest=1.5.0`.

## Local Verification Snapshot

- `npm.cmd run build`: passed.
- `npm.cmd run test:unit`: 716 tests, 714 passed, 2 skipped, 0 failed.
- `npm.cmd run doctor:ci`: 83 OK, 0 warnings, 0 failures.
- `npm.cmd run verify:package`: passed; 584 package files, no private local launchers.
- `npm.cmd test`: passed in 284.5 seconds in an approved Windows child-process
  environment. This includes 139 security smoke checks, 716 unit tests (714
  passed, 2 skipped), 22 lifecycle checks, doctor, tunnel/watcher supervisors,
  Windows control, MCP manifest, brand, and 32 Control Center checks.
- `npm.cmd run test:mcp`: passed.
- `npm.cmd run test:http-mcp`: 13 passed, 0 failed, including owner-token checks.
- `npm.cmd run pack:clean` was not run here because it removes and recreates
  release artifacts; run it only in an explicitly approved release-preparation
  workspace.

## Release Verification Checklist

- [ ] Confirm the target version in `package.json`.
- [ ] Confirm `src/version.ts`, package metadata, README version text, and
      changelog agree.
- [ ] Run the complete local gate chain from `AGENTS.md`.
- [ ] Open a PR and wait for the GitHub CI gate.
- [ ] Merge only after review.
- [ ] Create the tag from the verified merge commit.
- [ ] Create the GitHub Release with reviewed artifacts and checksums.
- [ ] Publish `patchwarden` to npm using process-scoped authentication.
- [ ] Verify the remote tag, GitHub Release, npm package version, and
      `dist-tags.latest`.

Do not publish new versions under the frozen pre-rename package name.
