# PatchWarden Control Center

PatchWarden has three control layers:

1. Web dashboard: the daily management surface for status, setup checks, tasks,
   stale-task actions, Direct sessions, audit logs, and long logs.
2. Tray entry: a lightweight quick-control surface for opening the dashboard,
   checking compact status, Start/Stop/Restart, opening logs, and quitting the
   tray.
3. CLI/scripts: the lower-level fallback for automation, smoke tests, package
   checks, and troubleshooting.

## User Entrypoints

From the repository root:

```powershell
.\PatchWarden-Desktop.cmd
.\PatchWarden-Control.cmd
.\PatchWarden-Control-Tray.cmd --foreground
.\PatchWarden.cmd status all
```

Use `PatchWarden-Control.cmd` for normal desktop use. Use the tray when you only
need quick controls. Use `PatchWarden.cmd` when you need explicit CLI output or
automation-friendly commands.

## Design Notes

- v1.3 Dashboard panels show bounded task lineage, project policy, and release
  readiness summaries. The backing APIs are read-only and do not expose full
  stdout/stderr, full diffs, long logs, or secret-bearing files.
- v1.4 extends the lineage panel with Direct-assisted verification status and
  exposes a safe Direct session summary API without stdout/stderr tails or diffs.
- v1.5 adds an Evidence Pack dashboard card plus read-only
  `/api/evidence-packs` and `/api/evidence-packs/:lineage_id` routes. These
  APIs return bounded lineage/policy/catalog evidence and omit stdout/stderr,
  full diffs, verification logs, and sensitive file content.
- `control-center-mvp.md`: first Web dashboard scope.
- `control-center-phase2.md`: follow-up management and diagnostics scope.
- `control-center-daily-driver.md`: current daily-use contract.

