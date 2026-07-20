# PatchWarden Release Evidence

This file separates local source state from public release truth. Update it
before submitting external applications or publishing a release.

## Current Snapshot

Remote facts checked on 2026-07-19. Local source and branch values were read
from the PatchWarden workspace and are not evidence that a public package was
published.

| Surface | Current evidence |
| --- | --- |
| Local branch | `codex/windows-desktop-tunnel-fixes` |
| Local `package.json` | `patchwarden@1.6.1` |
| GitHub latest release | `v1.6.0` |
| GitHub release URL | https://github.com/jiezeng2004-design/PatchWarden/releases/tag/v1.6.0 |
| GitHub release published on | 2026-07-16 |
| npm latest | `patchwarden@1.5.1` |
| npm `dist-tags.latest` | `1.5.1` |
| GitHub stars | 2 |
| GitHub forks | 0 |
| Open issues | 9 |
| Open pull requests | 4 |

Conclusion: local source is `v1.6.1`; the last verified GitHub Release is
`v1.6.0`, while npm `latest` remains `1.5.1`. Do not describe the public
release surfaces as synchronized until GitHub, npm, and `dist-tags.latest` are
independently verified at the intended version.

## Commands Used

Windows PowerShell:

```powershell
gh repo view jiezeng2004-design/PatchWarden --json nameWithOwner,stargazerCount,forkCount,issues,pullRequests,defaultBranchRef,pushedAt,url,description,licenseInfo,repositoryTopics,latestRelease,hasDiscussionsEnabled,hasIssuesEnabled,securityPolicyUrl
gh release view v1.6.0 --repo jiezeng2004-design/PatchWarden --json tagName,name,publishedAt,isDraft,isPrerelease,url
gh release view --repo jiezeng2004-design/PatchWarden --json tagName,name,publishedAt,isDraft,isPrerelease,url
npm.cmd view patchwarden version dist-tags --json --cache .\.npm-cache
```

The npm query was verified on 2026-07-19: `version=1.5.1` and
`dist-tags.latest=1.5.1`.

## Local Verification Snapshot (Separate From Remote Truth)

The following 2026-07-19 baseline checks describe the local working tree only.
They do not prove GitHub/npm publication state, and the complete gate must be
rerun after the current optimization work finishes.

- Root TypeScript `--noEmit` and the Desktop TypeScript build: passed.
- Targeted reliability/security tests: 49 passed; targeted Desktop backend
  lifecycle tests: 8 passed.
- `npm.cmd test`: passed on the second baseline run, including 139/139 security
  checks, 747 passed and 2 skipped unit tests, 22/22 lifecycle checks, and
  32/32 Control Center checks. An earlier run exposed one Git commit setup
  flake; the test setup was then hardened.
- `npm.cmd run test:mcp`: passed.
- `npm.cmd run test:http-mcp`: 13 passed, 0 failed.
- `npm.cmd run desktop:test`: 41 passed, 0 failed at the baseline snapshot.
- Root and Desktop dependency audits: 0 known vulnerabilities.
- `npm.cmd run pack:clean` was not run for this historical baseline. Current
  versions recreate only `release/package/` plus the two root package archives;
  Desktop and preflight siblings under `release/` are preserved. It still
  overwrites those package artifacts, so run it only during explicitly approved
  release preparation.

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
