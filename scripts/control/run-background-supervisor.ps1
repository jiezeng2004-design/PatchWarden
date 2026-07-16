[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("chatgpt_core", "chatgpt_direct")]
  [string]$ToolProfile,

  [Parameter(Mandatory = $true)]
  [ValidateSet("patchwarden", "patchwarden-direct")]
  [string]$Profile,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^127\.0\.0\.1:\d+$')]
  [string]$HealthListenAddr,

  [switch]$SkipWatcher
)

$ErrorActionPreference = "Stop"
$launcherScript = Join-Path $PSScriptRoot "start-patchwarden-tunnel.ps1"
$runtimeName = if ($ToolProfile -eq "chatgpt_direct") { "runtime-direct" } else { "runtime" }
$runtimeDirectory = Join-Path $env:LOCALAPPDATA "patchwarden\$runtimeName"
$stdout = Join-Path $runtimeDirectory "supervisor.stdout.log"
$stderr = Join-Path $runtimeDirectory "supervisor.stderr.log"

New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
$arguments = @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $launcherScript,
  "-ToolProfile", $ToolProfile,
  "-Profile", $Profile,
  "-HealthListenAddr", $HealthListenAddr,
  "-NoTunnelWebUi"
)
if ($SkipWatcher) { $arguments += "-SkipWatcher" }

try {
  & powershell.exe @arguments 1> $stdout 2> $stderr
  exit $LASTEXITCODE
} catch {
  $_ | Out-String | Set-Content -LiteralPath $stderr -Encoding UTF8
  exit 1
}
