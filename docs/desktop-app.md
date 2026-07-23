# PatchWarden Windows Desktop

PatchWarden Desktop is the installable Windows shell for the existing local
Control Center. It does not add a remote shell or replace the MCP server. The
desktop process starts the same loopback-only Control Center, displays it in an
isolated Electron window, and keeps quick controls in the system tray.

## Install

1. Download `PatchWarden-Setup-<version>-x64.exe` (installed) or
   `PatchWarden-Portable-<version>-x64.zip` (no install), plus
   `PatchWarden-Desktop-SHA256SUMS.txt` from the matching GitHub Release.
2. Verify the SHA256 value before running the installer.
3. Install for the current Windows user. Administrator access is not required.
4. Select a dedicated workspace, review detected local CLIs and models, and let
   the read-only doctor finish.

## First-run routes

The first screen asks whether PatchWarden will be used through **ChatGPT
Tunnel** or **Local MCP**. Local MCP can skip Platform Tunnel configuration.
For ChatGPT, use the same eight steps shown in both READMEs:

1. Confirm Platform Tunnel access and enable developer mode for the target ChatGPT workspace.
2. Create a Tunnel in [Platform Tunnel settings](https://platform.openai.com/settings/organization/tunnels) and associate that workspace.
3. Detect or choose an existing `tunnel-client.exe` in Desktop Settings.
4. Enter the Core Tunnel ID and dedicated Tunnel runtime API key used as `CONTROL_PLANE_API_KEY`. It is not an application `OPENAI_API_KEY`.
5. Configure and test the environment, direct, or credential-free HTTP/HTTPS/SOCKS5 (Mixed) proxy.
6. Configure the Core profile, run `tunnel-client doctor --explain --json`, and start Core. The runtime key travels from the isolated renderer to the main process over bounded IPC, then to a one-time PowerShell process over stdin. It is DPAPI-encrypted only after doctor succeeds and is never placed in repository config, HTTP APIs, command arguments, logs, or returned objects.
7. Confirm Tunnel ready, Watcher healthy, and the fixed 26-tool `chatgpt_core` catalog on Getting Started.
8. In ChatGPT **Settings → Plugins**, create a developer-mode app, choose the Tunnel, reconnect, open a new chat, and call `health_check`.

The current term is **developer-mode app / Plugins**; older releases called it
a Connector. Direct remains optional and must be enabled explicitly. Start All
starts Core and reports Direct as skipped while Direct is disabled; Stop All
still covers both profiles.

The setup flow searches `PATH`, current-user application directories, and a
bounded area next to the selected workspace for `tunnel-client.exe`. If it is
not found, continue into the read-only console and open **Settings > MCP and
tunnel**. Use **Detect** or the dedicated file picker; it accepts only an
existing file named `tunnel-client.exe`. PatchWarden never downloads or runs
new software automatically. Download the Windows x64 build only from the
trusted release source named by your tunnel provider and compare its SHA256
with that release before selecting it.

Prerequisites are Windows x64, Node.js 18 or newer, and the configured
tunnel-client used by the existing Core/Direct launcher chain. Electron runs
the desktop window and Control Center child, but does not replace those runtime
requirements.

The first unsigned desktop release may show Windows SmartScreen. Verify the
checksum and GitHub Release source before choosing to continue. No updater or
login startup entry is installed in v1.

## Local agents and models

Desktop supports Codex, OpenCode, Claude Code, Gemini CLI, GitHub Copilot CLI,
Qwen Code, Kimi Code, and Aider. Settings detects only verified native
executables or known npm package entry points and never launches Windows shell
shims through a command shell.

Model discovery reads only allowlisted model fields from each agent's normal
JSON/JSONC, TOML, or YAML settings. It does not read `.env`, API keys, browser
state, provider secrets, or session history. Online model listing is never run
automatically; the user must select the refresh control for an agent that
supports a bounded model-list command. Choosing **Follow agent default** omits
the model argument so the agent retains its own precedence rules.

## Local state

- Desktop config: `%LOCALAPPDATA%\PatchWarden\patchwarden.config.json`
- Desktop preferences: `%LOCALAPPDATA%\PatchWarden\desktop-preferences.json`
- Desktop startup log: `%LOCALAPPDATA%\PatchWarden\desktop.log`
- Control Center logs: `%LOCALAPPDATA%\patchwarden\control-center`
- Tasks and evidence remain below the selected workspace.

If `PATCHWARDEN_CONFIG` points to a valid config, the desktop app uses that path
instead of creating the LocalAppData config. Config changes are written
atomically and the previous file is retained as a timestamped `.bak-*` copy.
Uninstalling the app does not remove config, tasks, evidence, or workspace data.

## Runtime behavior

- The app binds only to `127.0.0.1:8090` and reuses an existing verified
  PatchWarden Control Center on that address.
- A foreign listener on port 8090 is reported; the app never kills it or takes
  the port.
- Closing the window hides it to the tray by default. `Exit desktop app` stops
  only the Control Center child owned by that app process.
- Desktop-owned utility and PowerShell children receive a minimal runtime and
  proxy environment. Provider variables require an explicit Agent allow-list,
  while Control/Tunnel owner credentials are always removed. Windows
  PowerShell and `where.exe` are resolved from the system directory rather than
  the selected workspace or its current directory.
- Backend restarts are serialized. A restart waits for the exact owned child to
  emit `exit` (or reach a bounded timeout), and a configuration change received
  during an active restart schedules one further restart instead of racing it.
- `Stop all and exit` explicitly requests the existing bounded stop action for
  Core/Direct before closing.
- Start/restart succeeds only after the selected tunnel health endpoint is
  ready and the Core watcher heartbeat is healthy. Early supervisor exits and
  timeouts are reported with a reason and next steps.
- Background start uses `run-background-supervisor.ps1` so the lifecycle API
  returns without holding the long-running supervisor's output handles. The
  wrapper writes bounded `supervisor.stdout.log` and `supervisor.stderr.log`
  files while `supervisor-status.json` records only PID, state, timestamps, and
  log paths.
- The legacy CMD, PowerShell tray, and browser Dashboard remain supported.

## MCP and proxy settings

The desktop settings page can enable the Direct profile and configure tunnel
proxy behavior. Direct remains disabled until the user explicitly enables it.

- **Use environment proxy** inherits `HTTPS_PROXY` when it is present.
- **No proxy** removes proxy variables for the launcher-owned tunnel process.
- **Manual proxy** accepts only `http`, `https`, or `socks5` URLs without an
  embedded username or password.

Core and Direct can share one proxy definition or use separate definitions.
PatchWarden does not store proxy credentials in URLs or logs.

## Build from source

Run from the repository in Windows PowerShell:

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd install --prefix desktop --cache .\.npm-cache
npm.cmd run desktop:test
npm.cmd run desktop:preflight
npm.cmd run desktop:package
```

Artifacts are written below `release\desktop`. Desktop dependencies remain in
the private `desktop` package and are not included in the `patchwarden` npm
package.

Desktop staging must include `scripts/checks/mcp-manifest-check.js` and the
root package-lock production dependency closure below `resources/core/node_modules`.
Validate the unpacked runtime from a directory outside the repository so it
cannot accidentally resolve dependencies from the developer checkout.

`npm.cmd run desktop:preflight` automates that isolated validation and writes a
privacy-bounded receipt in a unique `release/desktop-preflight-*` directory.
The receipt records the branch, commit, dirty-state hashes, toolchain versions,
check durations, package file count, runtime manifest digest, unpacked
executable digest, and UI smoke result. It stores no diff content, credentials,
configuration values, or browser state. The smoke process uses temporary
`LOCALAPPDATA` / `APPDATA`, a nonexistent isolated config, and launcher-owned
processes only.

Viewport DOM metrics, page readiness, and the single-instance result are hard
smoke gates. Electron screenshots are best-effort evidence because Windows
graphics capture can be unavailable in CI sessions; capture failures are
counted in the receipt without crashing Desktop. Local visual acceptance can
pass `--require-screenshots` to `desktop/scripts/smoke-unpacked.mjs`, or use
`--no-capture` while an external UI automation tool owns Windows Graphics
Capture.

For a release candidate, run `npm.cmd run desktop:preflight:release`. It rejects
dirty worktrees. The regular preflight remains available for validating an
intentional local working-tree baseline before it is committed.

## Release checklist

1. From a clean checkout, run `npm.cmd run desktop:preflight:release`, then the
   full core validation chain and `npm.cmd run desktop:package`.
2. Install and uninstall on a clean Windows x64 environment without elevation.
3. Verify first-run setup, tray behavior, restart, explicit exit, and retained
   user data after uninstall.
4. Compare the installer SHA256 with the generated checksum file.
5. Publish GitHub assets manually. npm publication remains a separate action.
