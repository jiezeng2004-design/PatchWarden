# Proposed StepSecurity Dev Machine Guard Integration

Status checked 2026-07-28: PR [#180](https://github.com/step-security/dev-machine-guard/pull/180)
is open and ready for review. It is not merged and does not establish official
support.

Target: [step-security/dev-machine-guard](https://github.com/step-security/dev-machine-guard)

## Why Detect PatchWarden

Dev Machine Guard inventories AI agents, MCP configuration, developer tools,
and package-manager risk. Detecting PatchWarden would add useful context: the
machine has a local AI agent security tool that acts as an execution guard and
an MCP/local-agent safety layer.

This is an inventory signal, not proof that every agent action is governed.
PatchWarden only enforces operations routed through it, and its presence must
not be reported as sandboxing or complete endpoint protection.

## Detection Evidence

The first contribution should be binary-first:

- primary CLI binary: `patchwarden`
- npm package name: `patchwarden`
- output category supported by Dev Machine Guard: `cli_tool`
- proposed vendor value: `OpenSource`

The package also exposes `patchwarden-confirm` and `patchwarden-runner`, but the
minimal detector should use the primary `patchwarden` binary as installation
evidence. An arbitrary `.patchwarden/` directory is not sufficient: repositories
may retain task artifacts after the CLI has been removed.

PatchWarden has no standardized user-level configuration directory suitable
for Dev Machine Guard's `ConfigDirs` field. Current runtime configuration is
resolved in this order:

1. a path supplied through `PATCHWARDEN_CONFIG`
2. `patchwarden.config.json` in the process working directory
3. `.patchwarden.json` in the process working directory

PatchWarden v1.6.6 also recognizes the repository-level policy file
`.patchwarden/project-policy.json`. That file is a project marker, not a
user-level config directory and not standalone proof that the CLI is installed.

## Expected JSON Shape

This draft uses the existing Dev Machine Guard `AITool` schema and does not
invent new output fields:

```json
{
  "name": "patchwarden",
  "vendor": "OpenSource",
  "type": "cli_tool",
  "version": "<installed package version>",
  "binary_path": "<resolved path to patchwarden or its npm shim>",
  "install_path": "<resolved patchwarden npm package root>"
}
```

`config_dir` is an existing optional `AITool` field, but the first PatchWarden
detector should leave it empty; Go's `omitempty` then omits it from JSON. Add it
only if PatchWarden later standardizes a user-level configuration directory.

The actual version must come from installed metadata. Dev Machine Guard already
prefers npm `package.json` metadata before executing third-party tools. This is
important because PatchWarden v1.6.6 does not define a standalone
`patchwarden --version` mode; the detector must not rely on that command as its
identity check.

## Upstream Change Sketch

- Add a `patchwarden` entry to `internal/detector/aicli.go` with binary
  `patchwarden` and no guessed home config directory.
- Add detector tests for PATH discovery, Windows npm shims, static version
  metadata, missing binaries, and stale `.patchwarden/` directories.
- Update `SCAN_COVERAGE.md` and any applicable README detection table.
- Keep project-policy discovery out of the first PR unless maintainers want a
  separate project-marker detector.

## Pull Request Draft

Title:

> feat(detector): add PatchWarden detection

Description:

> Add binary-first detection for PatchWarden, an open-source AI agent security
> CLI and MCP/local-agent execution guard. The detector reports the existing
> `patchwarden` binary through the current `AITool` `cli_tool` schema and uses
> static npm metadata for version resolution. It does not treat a
> `.patchwarden/` directory as proof of installation, preventing stale project
> artifacts from producing false positives. This change is an inventory
> integration only and does not claim that PatchWarden governs every agent
> action on the machine.

## Test Plan Draft

- Unit test a resolved Unix binary inside the `patchwarden` npm package.
- Unit test a Windows npm `.cmd` shim and package-root resolution.
- Verify the detected JSON fields match the existing `AITool` schema.
- Verify a missing binary produces no result even when `.patchwarden/` exists.
- Verify an invalid or missing package version returns `unknown` without
  hanging or starting an MCP server.
- Run upstream `make lint`, `make test`, and `make smoke`.

Before submission, re-check the upstream detector arrays, contribution guide,
and output schema against its current default branch.
