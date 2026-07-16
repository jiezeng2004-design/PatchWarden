[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("core", "direct")]
  [string]$Mode,
  [AllowEmptyString()]
  [string]$TunnelId = "",
  [Parameter(Mandatory = $true)]
  [string]$TunnelClientExe,
  [Parameter(Mandatory = $true)]
  [string]$ConfigPath,
  [Parameter(Mandatory = $true)]
  [string]$CredentialPath,
  [ValidateSet("environment", "none", "manual")]
  [string]$ProxyMode = "environment",
  [AllowEmptyString()]
  [string]$ProxyUrl = "",
  [switch]$UseSavedCredential
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Profile = if ($Mode -eq "direct") { "patchwarden-direct" } else { "patchwarden" }
$ToolProfile = if ($Mode -eq "direct") { "chatgpt_direct" } else { "chatgpt_core" }
$LauncherName = if ($Mode -eq "direct") { "patchwarden-mcp-direct.cmd" } else { "patchwarden-mcp-stdio.cmd" }
$HealthListenAddr = if ($Mode -eq "direct") { "127.0.0.1:8081" } else { "127.0.0.1:8080" }
$ProfilePath = Join-Path $env:APPDATA "tunnel-client\$Profile.yaml"
$McpLauncher = (Join-Path $ProjectRoot "scripts\mcp\$LauncherName") -replace "\\", "/"
$profileBackup = "$ProfilePath.patchwarden-provision-backup-$PID"
$hadProfile = Test-Path -LiteralPath $ProfilePath
$runtimeKey = $null

function Write-Result {
  param([bool]$Ok, [string]$ReasonCode, [string]$NextStep)
  [ordered]@{ ok = $Ok; reason_code = $ReasonCode; next_step = $NextStep } | ConvertTo-Json -Compress
}

function Get-DoctorReason {
  param([string]$Text)
  $value = [string]$Text
  if ($value -match '(?i)unauthor|forbidden|invalid.*(?:key|token)|authentication|401|403') { return "authentication_failed" }
  if ($value -match '(?i)proxy|ECONNREFUSED|connection refused|connect.*failed|timeout|timed out') { return "proxy_unreachable" }
  if ($value -match '(?i)region|country|unsupported location|not available in') { return "region_unsupported" }
  return "doctor_failed"
}

try {
  if (-not (Test-Path -LiteralPath $TunnelClientExe -PathType Leaf)) { throw "tunnel_client_missing" }
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "config_missing" }
  if (-not (Test-Path -LiteralPath ($McpLauncher -replace "/", "\") -PathType Leaf)) { throw "mcp_launcher_missing" }
  if ($UseSavedCredential) {
    if (-not (Test-Path -LiteralPath $ProfilePath -PathType Leaf)) { throw "tunnel_profile_missing" }
    if (-not (Test-Path -LiteralPath $CredentialPath -PathType Leaf)) { throw "tunnel_credential_missing" }
    $secure = ConvertTo-SecureString (Get-Content -LiteralPath $CredentialPath -Raw -Encoding UTF8)
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $runtimeKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) } }
  } else {
    if ([string]::IsNullOrWhiteSpace($TunnelId)) { throw "tunnel_id_missing" }
    $runtimeKey = [Console]::In.ReadLine()
  }
  if ([string]::IsNullOrWhiteSpace($runtimeKey)) { throw "runtime_key_missing" }
  $env:CONTROL_PLANE_API_KEY = $runtimeKey
  $env:PATCHWARDEN_CONFIG = $ConfigPath
  $env:NO_PROXY = "localhost,127.0.0.1,::1"

  $useProxy = $false
  switch ($ProxyMode) {
    "manual" {
      $proxyUri = $null
      if (-not [Uri]::TryCreate($ProxyUrl, [UriKind]::Absolute, [ref]$proxyUri) -or $proxyUri.Scheme -notin @("http", "https", "socks5")) { throw "proxy_invalid" }
      if (-not [string]::IsNullOrEmpty($proxyUri.UserInfo)) { throw "proxy_credentials_forbidden" }
      $env:HTTP_PROXY = $ProxyUrl; $env:HTTPS_PROXY = $ProxyUrl; $env:ALL_PROXY = $ProxyUrl
      $useProxy = $true
    }
    "none" { Remove-Item Env:HTTP_PROXY, Env:HTTPS_PROXY, Env:ALL_PROXY -ErrorAction SilentlyContinue }
    "environment" { $useProxy = -not [string]::IsNullOrWhiteSpace($env:HTTPS_PROXY) }
  }

  if (-not $UseSavedCredential) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ProfilePath) | Out-Null
    if ($hadProfile) { Copy-Item -LiteralPath $ProfilePath -Destination $profileBackup -Force }
    & $TunnelClientExe init --sample sample_mcp_stdio_local --profile $Profile --tunnel-id $TunnelId --mcp-command $McpLauncher --force | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "profile_init_failed" }

    $profileText = Get-Content -LiteralPath $ProfilePath -Raw -Encoding UTF8
    if ($profileText -match 'listen_addr:\s*"[^"]*"') {
      $profileText = $profileText -replace '(listen_addr:\s*)"[^"]*"', "`$1`"$HealthListenAddr`""
    } elseif ($profileText -match '(?m)^health:') {
      $profileText = $profileText -replace '(?m)^(health:.*)$', "`$1`n  listen_addr: `"$HealthListenAddr`""
    } else {
      $profileText = "$($profileText.TrimEnd())`n`nhealth:`n  listen_addr: `"$HealthListenAddr`"`n"
    }
    Set-Content -LiteralPath $ProfilePath -Value $profileText -Encoding UTF8 -NoNewline
  }

  $doctorArgs = @("doctor", "--profile", $Profile, "--explain", "--json")
  if ($useProxy) { $doctorArgs += @("--http-proxy", "env:HTTPS_PROXY") }
  $doctorOutput = (& $TunnelClientExe @doctorArgs 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw (Get-DoctorReason -Text $doctorOutput) }

  if (-not $UseSavedCredential) {
    $secure = ConvertTo-SecureString $runtimeKey -AsPlainText -Force
    $encrypted = ConvertFrom-SecureString $secure
    $credentialDirectory = Split-Path -Parent $CredentialPath
    New-Item -ItemType Directory -Force -Path $credentialDirectory | Out-Null
    $credentialTemp = "$CredentialPath.tmp-$PID"
    Set-Content -LiteralPath $credentialTemp -Value $encrypted -Encoding UTF8 -NoNewline
    Move-Item -LiteralPath $credentialTemp -Destination $CredentialPath -Force
  }
  Remove-Item -LiteralPath $profileBackup -Force -ErrorAction SilentlyContinue
  Write-Result -Ok $true -ReasonCode "configured" -NextStep "start_core"
  exit 0
} catch {
  if ($hadProfile -and (Test-Path -LiteralPath $profileBackup)) {
    Move-Item -LiteralPath $profileBackup -Destination $ProfilePath -Force
  } elseif (-not $hadProfile) {
    Remove-Item -LiteralPath $ProfilePath -Force -ErrorAction SilentlyContinue
  }
  $reason = [string]$_.Exception.Message
  if ($reason -notmatch '^[a-z0-9_]+$') { $reason = "provisioning_failed" }
  Write-Result -Ok $false -ReasonCode $reason -NextStep $(if ($reason -eq "authentication_failed") { "replace_runtime_key" } elseif ($reason -eq "proxy_unreachable") { "check_proxy" } else { "review_tunnel_setup" })
  exit 1
} finally {
  $env:CONTROL_PLANE_API_KEY = $null
  $runtimeKey = $null
}
