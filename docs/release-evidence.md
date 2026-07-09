# PatchWarden Release Evidence

This file separates local source state from public release truth. Update it
before submitting external applications or publishing a release.

## Current Snapshot

Checked on 2026-07-09 from the PatchWarden workspace.

| Surface | Current evidence |
| --- | --- |
| Local branch | `codex/patchwarden-v1.5.0` |
| Local `package.json` | `patchwarden@1.5.1` |
| GitHub latest release | `v1.5.0` |
| GitHub release URL | https://github.com/jiezeng2004-design/PatchWarden/releases/tag/v1.5.0 |
| GitHub release published at | 2026-07-07T11:36:48Z |
| npm latest | `patchwarden@1.5.0` |
| npm `dist-tags.latest` | `1.5.0` |
| GitHub stars | 2 |
| GitHub forks | 0 |
| Open issues | 0 |
| Open pull requests | 0 |

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

Note: the npm query produced the expected `1.5.0` output but the command did
not exit before the local timeout. Re-run before final submission or release.

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
