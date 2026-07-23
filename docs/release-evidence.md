# PatchWarden Release Evidence

This file separates local source state from public release truth. Update it
before submitting external applications or publishing a release.

## Current Snapshot

Remote facts checked on 2026-07-23 after the v1.6.1 release completed.

| Surface | Current evidence |
| --- | --- |
| Verified merge commit | `2ab2b7405d89b12c4ef10febf56404de59c04053` |
| Local `package.json` | `patchwarden@1.6.1` |
| GitHub latest release | `v1.6.1` |
| GitHub release URL | https://github.com/jiezeng2004-design/PatchWarden/releases/tag/v1.6.1 |
| GitHub release published on | 2026-07-23 |
| npm latest | `patchwarden@1.6.1` |
| npm `dist-tags.latest` | `1.6.1` |
| GitHub stars | 2 |
| GitHub forks | 0 |
| Open issues | 5 |
| Open pull requests | 1 |

Conclusion: source, Git tag, GitHub Release, npm package version, and
`dist-tags.latest` are independently verified at `v1.6.1`.

## Commands Used

Windows PowerShell:

```powershell
gh repo view jiezeng2004-design/PatchWarden --json nameWithOwner,stargazerCount,forkCount,issues,pullRequests,defaultBranchRef,pushedAt,url,description,licenseInfo,repositoryTopics,latestRelease,hasDiscussionsEnabled,hasIssuesEnabled,securityPolicyUrl
gh release view v1.6.1 --repo jiezeng2004-design/PatchWarden --json tagName,name,publishedAt,isDraft,isPrerelease,url
gh release view --repo jiezeng2004-design/PatchWarden --json tagName,name,publishedAt,isDraft,isPrerelease,url
npm.cmd view patchwarden version dist-tags --json --cache .\.npm-cache
```

The npm query was verified on 2026-07-23: `version=1.6.1` and
`dist-tags.latest=1.6.1`.

## v1.6.1 Verification Snapshot

- GitHub CI: Node.js 18, Ubuntu Node.js 20, Windows Node.js 20, secret scan,
  Windows Desktop installer, and final CI gate passed.
- Core security smoke: 141/141; unit tests: 855 passed and 3 skipped;
  lifecycle: 22/22; HTTP MCP: 17/17; MCP smoke and Doctor passed.
- Desktop tests: 54/54; clean-source Desktop preflight and packaged UI smoke
  passed from the verified merge commit.
- Root and Desktop dependency audits: 0 known vulnerabilities.
- Clean release directory: 532 files; npm package manifest: 531 files.
- GitHub Release: six reviewed assets with GitHub-computed and local SHA-256
  digests; installer signature status is explicitly documented as unsigned.

## Release Verification Checklist

- [x] Confirm the target version in `package.json`.
- [x] Confirm `src/version.ts`, package metadata, README version text, and
      changelog agree.
- [x] Run the complete local gate chain from `AGENTS.md`.
- [x] Open a PR and wait for the GitHub CI gate.
- [x] Merge only after review.
- [x] Create the tag from the verified merge commit.
- [x] Create the GitHub Release with reviewed artifacts and checksums.
- [x] Publish `patchwarden` to npm using process-scoped authentication.
- [x] Verify the remote tag, GitHub Release, npm package version, and
      `dist-tags.latest`.

Do not publish new versions under the frozen pre-rename package name.
