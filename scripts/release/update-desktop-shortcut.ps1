[CmdletBinding()]
param(
    [string]$ReleaseDirectory,
    [string]$ShortcutPath
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ReleaseDirectory)) {
    $repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $ReleaseDirectory = Join-Path $repositoryRoot "release\desktop"
}
if ([string]::IsNullOrWhiteSpace($ShortcutPath)) {
    $ShortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "PatchWarden.lnk"
}

$targetPath = Join-Path $ReleaseDirectory "win-unpacked\PatchWarden.exe"
if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
    throw "Portable executable not found: $targetPath"
}

$targetPath = (Resolve-Path -LiteralPath $targetPath).Path
$workingDirectory = Split-Path -Parent $targetPath
$shortcutDirectory = Split-Path -Parent $ShortcutPath
if (-not (Test-Path -LiteralPath $shortcutDirectory -PathType Container)) {
    throw "Shortcut directory not found: $shortcutDirectory"
}

$shortcutName = [System.IO.Path]::GetFileNameWithoutExtension($ShortcutPath)
$temporaryShortcut = Join-Path $shortcutDirectory ("{0}.tmp-{1}.lnk" -f $shortcutName, $PID)
$shell = $null
$shortcut = $null

try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($temporaryShortcut)
    $shortcut.TargetPath = $targetPath
    $shortcut.WorkingDirectory = $workingDirectory
    $shortcut.IconLocation = "$targetPath,0"
    $shortcut.Description = "PatchWarden Portable"
    $shortcut.Save()

    Move-Item -LiteralPath $temporaryShortcut -Destination $ShortcutPath -Force
}
finally {
    if ($null -ne $shortcut) {
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
    }
    if ($null -ne $shell) {
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
    }
    if (Test-Path -LiteralPath $temporaryShortcut) {
        Remove-Item -LiteralPath $temporaryShortcut -Force
    }
}

[pscustomobject]@{
    ok = $true
    shortcut = $ShortcutPath
    target = $targetPath
} | ConvertTo-Json -Compress
