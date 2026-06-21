# Migrating from Safe-Bifrost to PatchWarden

PatchWarden v0.4.0 is an intentional pre-1.0 breaking rename. It does not load
legacy names automatically.

## Package and commands

- Replace `safe-bifrost` with `patchwarden` in npm dependencies and MCP client
  commands.
- Replace the old runner command with `patchwarden-runner`.
- Replace Windows launchers with the corresponding `PatchWarden` launchers.

## Configuration

1. Copy `safe-bifrost.config.json` to `patchwarden.config.json`.
2. Change `plansDir` and `tasksDir` from `.safe-bifrost/...` to
   `.patchwarden/...`.
3. Rename every `SAFE_BIFROST_*` environment variable to `PATCHWARDEN_*`.
4. Replace `x-safe-bifrost-token` with `x-patchwarden-token` for local HTTP
   authentication.

## Local state

PatchWarden writes new task state under `.patchwarden`, runtime status under
`%LOCALAPPDATA%\patchwarden`, and the DPAPI tunnel credential under
`%APPDATA%\patchwarden`. Old directories are not deleted or migrated
automatically. Keep them as a backup until the new installation is verified.

The old DPAPI credential is intentionally not copied. Run the new tunnel
launcher and enter the control-plane key again so PatchWarden can save it under
the new application directory.
