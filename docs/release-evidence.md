# PatchWarden Release Evidence

This file separates local source state from public release truth. Update it
before submitting external applications or publishing a release.

## Current Snapshot

Remote facts checked again on 2026-07-30 after the v1.6.7 release completed.

| Surface | Current evidence |
| --- | --- |
| Remote `main` | `5192ee379158370e977b36ee071d40bd24450609` |
| Annotated tag object | `41b7f8393d79b058d8a6f42f29c44d7a152863ba` |
| Tag peeled commit | `69103b2b649e31ee2a8014f5d20616c5ad6b68ba` |
| Local `package.json` | `patchwarden@1.6.7` |
| GitHub latest release | `v1.6.7` |
| GitHub release URL | https://github.com/jiezeng2004-design/PatchWarden/releases/tag/v1.6.7 |
| GitHub release published at | `2026-07-28T10:21:44Z` |
| GitHub release state | non-draft, non-prerelease |
| GitHub release target | `69103b2b649e31ee2a8014f5d20616c5ad6b68ba` |
| npm latest | `patchwarden@1.6.7` |
| npm `dist-tags.latest` | `1.6.7` |
| npm `gitHead` | `69103b2b649e31ee2a8014f5d20616c5ad6b68ba` |
| npm published at | `2026-07-28T10:00:41.420Z` |
| GitHub stars | 2 |
| GitHub forks | 0 |
| Open issues | 5 |
| Open pull requests | 1 |

Conclusion: source, Git tag, GitHub Release, npm package version, and
`dist-tags.latest` are independently verified at `v1.6.7`. The release tag
intentionally remains on the reviewed release commit while `main` contains
later documentation and dependency-maintenance commits.

## v1.6.7 Uploaded Asset Digests

GitHub reported these SHA-256 digests for the six uploaded Release assets. The
four distributable artifacts are recorded here:

| Uploaded asset | Size (bytes) | SHA-256 |
| --- | ---: | --- |
| `PatchWarden-v1.6.7.zip` | 1,855,482 | `273045c27554fa6e51542363c2d2f720418d460d858d24b4a07cfe8c8914bcb4` |
| `PatchWarden-v1.6.7.tar.gz` | 1,603,652 | `16907f6f2397ce81429456a23f9297197a8821b04572f41617d55a1312cf682b` |
| `PatchWarden-Setup-1.6.7-x64.exe` | 104,140,804 | `4647acc8944ba2355ccd8282b2232a1abe52e0f037830bab740e0e7313b05227` |
| `PatchWarden-Portable-1.6.7-x64.zip` | 145,120,180 | `f18f6b9b52ed8c2047d7e4c3d0c76de7b2efa99e725201698d272dd092eb2001` |

These values identify the uploaded assets on the formal GitHub Release. A
same-named archive generated later in a local checkout is not release evidence
and must not be substituted for these assets.

## Commands Used

Windows PowerShell:

```powershell
gh repo view jiezeng2004-design/PatchWarden --json nameWithOwner,stargazerCount,forkCount,issues,pullRequests,defaultBranchRef,pushedAt,url,description,licenseInfo,repositoryTopics,latestRelease,hasDiscussionsEnabled,hasIssuesEnabled,securityPolicyUrl
git ls-remote origin refs/heads/main refs/tags/v1.6.7 'refs/tags/v1.6.7^{}'
gh release view v1.6.7 --repo jiezeng2004-design/PatchWarden --json tagName,name,publishedAt,isDraft,isPrerelease,url,targetCommitish,assets
gh release view --repo jiezeng2004-design/PatchWarden --json tagName,name,publishedAt,isDraft,isPrerelease,url,targetCommitish
gh api repos/jiezeng2004-design/PatchWarden/releases/tags/v1.6.7 --jq '{tag_name: .tag_name, target_commitish: .target_commitish, draft: .draft, prerelease: .prerelease, published_at: .published_at, assets: [.assets[] | {name: .name, size: .size, digest: .digest, state: .state}]}'
npm.cmd view patchwarden@1.6.7 version dist-tags.latest gitHead time.1.6.7 dist.shasum dist.integrity --json
npm.cmd view patchwarden version dist-tags --json
```

The npm query was verified on 2026-07-30: `version=1.6.7`,
`dist-tags.latest=1.6.7`, and `gitHead` equals the peeled tag commit.

## v1.6.7 Save Verification

The post-release documentation save is checked locally with:

```powershell
npm.cmd run build
npm.cmd run check:release-metadata
npm.cmd run check:brand
npm.cmd run check:tool-manifest
npm.cmd run check:direct-tool-manifest
npm.cmd run check:search-tool-manifest
npm.cmd run test:mcp
npm.cmd run verify:package
```

The save check is local-only. It does not connect to or restart a configured
Core, Tunnel, Watcher, Desktop instance, and it does not recreate the formal
release artifacts.

Results from the 2026-07-29 isolated worktree save:

- The standard `npm.cmd test` chain passed: security smoke 141/141, unit tests
  970 passed and 3 skipped, lifecycle smoke 22/22, and Control Center smoke
  38/38; Doctor, Tunnel/Watcher supervisor, and Windows control checks also
  passed.
- Build, release metadata, and brand checks passed; the brand check scanned
  413 tracked files.
- Core, Direct, and Search manifests passed at 26, 14, and 5 tools. Their
  SHA-256 manifest hashes were `f4382139e70f9d5a7454d1d4b6e8736d4524ca2e4034894ad81fd69ed96d71c2`,
  `cf49517fc55bb447c5ae7cd12e7edda8cbf4966e95c37c831a1fe0a0f093d437`,
  and `f9f5482b968992fda825e6094096f19241321c26743b878176ce63166c2ed20b`.
- The isolated MCP smoke passed, including the disabled and enabled Direct
  profile paths.
- Package manifest verification passed with 572 files and no private local
  launchers.
- A read-only local-link scan resolved 190 links across 50 tracked Markdown
  files, and PyYAML parsed all 6 tracked YAML files.

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
