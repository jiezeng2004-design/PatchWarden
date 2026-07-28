# Manual release checklist

PatchWarden releases remain confirmation-gated. Creating a tag or GitHub Release does not publish npm automatically.

1. Work on a release branch and update `package.json`, changelog/release notes, README, examples, and tool manifests together.
2. Run the complete local quality gates from `AGENTS.md`. For Desktop, run `npm.cmd run desktop:preflight:release` from a clean checkout before creating the installer.
3. Open a pull request, wait for `CI gate`, review the diff and package contents, then merge.
4. Create the version tag from the verified merge commit.
5. Create the GitHub Release and attach only reviewed release artifacts and checksums.
6. Publish `patchwarden` to npm using process-scoped authentication; never store the raw token in the repository.
7. Verify `gh release view`, the remote tag, `npm.cmd view patchwarden version`, and `dist-tags.latest`.
8. Update or close the associated issue only after remote verification succeeds.

## Local artifact retention

Local release and preflight outputs are reproducible working artifacts, not a
replacement for GitHub Releases. Keep a rolling seven-day local window while
always preserving the current project version.

1. Confirm `package.json`, the local tag, GitHub Latest, and npm `latest` agree.
2. Confirm official GitHub Releases still exist for any expired versions whose
   local artifacts will be removed.
3. Run `npm.cmd run release:prune` and review every candidate and byte total.
4. Run `npm.cmd run release:prune -- --apply` only after the preview is correct.
5. Run the preview again; it must report zero expired candidates, while the
   current staging directory and Desktop `win-unpacked` runtime remain present.

The retention command is local-only. It must not delete Git commits, tags,
GitHub Releases, npm versions, unknown paths, or the active Desktop runtime.

Do not publish new versions under the frozen pre-rename package name.
