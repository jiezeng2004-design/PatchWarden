# PatchWarden Scripts

This directory keeps implementation scripts out of the root folder. Normal
desktop use should start from the root entrypoints:

```powershell
.\scripts\launchers\PatchWarden-Desktop.cmd
.\scripts\launchers\PatchWarden-Control.cmd
.\scripts\launchers\PatchWarden-Control-Tray.cmd --foreground
.\scripts\launchers\Stop-PatchWarden.cmd
.\PatchWarden.cmd status all
```

The installable Windows desktop shell is built separately with
`npm.cmd run desktop:package`. It preserves these source/npm entrypoints and
uses the same Control Center API rather than adding another process-management
surface. See `docs/desktop-app.md`.

## Control Scripts

- `control/manage-patchwarden.ps1`: backing implementation for `PatchWarden.cmd`.
- `control/start-control-center.ps1`: starts the local Web dashboard.
- `control/restart-control-center.ps1`: restarts the local Web dashboard.
- `control/control-center-tray.ps1`: Windows tray quick controls.
- `control/stop-patchwarden.ps1`: one-click shutdown for Core/Direct,
  Control Center, and tray.
- `control/start-patchwarden-tunnel.ps1`: starts Core or Direct tunnel supervision.
- `control/restart-patchwarden.ps1`: compatibility restart helper.

## MCP Entrypoints

- `mcp/patchwarden-mcp-stdio.cmd`: Core stdio MCP launcher.
- `mcp/patchwarden-mcp-direct.cmd`: Direct stdio MCP launcher.

## Smoke Tests And Checks

- `checks/*-smoke.js`: targeted smoke tests.
- `checks/unit-tests.js`: Node unit test entry.
- `checks/mcp-manifest-check.js`: validates MCP manifest expectations.
- `checks/release-metadata-check.js`: keeps local version declarations and
  documented Core/Direct manifest counts synchronized with the built catalog.
- `brand-check.js`: checks public brand strings.
- `checks/package-manifest-check.js`: verifies package contents.
- `checks/build-output-check.js`: verifies clean-output confinement and exact recursive unit-test compilation.
- `checks/release-retention-smoke.js`: verifies preview-first local artifact retention, workspace confinement, and fail-closed deletion.
- `checks/ui-version-smoke.js`: prevents stale hard-coded Core versions in Control Center shells.
- `checks/audit-ui-smoke.js`: verifies that the audit page uses one normalized conclusion source with reconciled totals, findings, actions, and structured evidence.
- `checks/direct-sessions-ui-smoke.js`: verifies that real Direct sessions default to the all-history view and filtered empty states remain recoverable.
- `checks/logs-ui-smoke.js`: verifies bilingual log controls, per-category cleared views, and last-request-wins category switching.
- `release/desktop-preflight.js`: builds an isolated Windows directory package and writes a bounded preflight receipt.

## Release Helpers

- `release/pack-clean.js`: rebuilds the isolated `release/package/` staging
  directory, `patchwarden-release.tar.gz`, and the versioned
  `PatchWarden-v*.zip` artifact. Desktop and preflight siblings under
  `release/` are preserved.
- `release/prune-local-artifacts.js`: previews local release artifacts older
  than seven days and removes only recognized candidates when `--apply` is
  explicitly supplied. The current version, current package staging,
  `release/desktop/win-unpacked`, checksum manifests, unknown paths, Git
  history, GitHub Releases, and npm versions are never pruned.

Preview the default seven-day policy before every cleanup:

```powershell
npm.cmd run release:prune
npm.cmd run release:prune -- --apply
```

Use `npm.cmd run release:prune -- --days 14 --apply` for a different positive
retention window. Any unsafe link, path escape, or deletion error makes the
command fail closed and leaves later candidates untouched.

## Compatibility Launchers

Compatibility `.cmd` files live under `scripts/launchers/`. User-private local
launchers belong under `.local/` and must stay out of Git and release packages.

