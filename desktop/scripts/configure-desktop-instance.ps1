param(
  [Parameter(Mandatory)] [string]$AppDir,
  [string]$InstanceRoot,
  [string]$FrontendPort,
  [string]$ApiPort,
  [string]$RedisPort
)
$ErrorActionPreference = 'Stop'
# Resolve existing ancestors by handle so junctions and short paths cannot hide
# data inside payloads. Missing suffixes are checked before creating any files.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class DesktopBoundaryPath {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder result, uint size, uint flags);
  public static string Resolve(string path) {
    using (var handle = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception();
      var text = new StringBuilder(32768);
      uint count = GetFinalPathNameByHandle(handle, text, (uint)text.Capacity, 0);
      if (count == 0 || count >= text.Capacity) throw new System.ComponentModel.Win32Exception();
      var final = text.ToString();
      if (final.StartsWith(@"\\?\UNC\")) return @"\\" + final.Substring(8);
      return final.StartsWith(@"\\?\") ? final.Substring(4) : final;
    }
  }
}
'@
function Resolve-BoundaryPath([string]$path) {
  $existing = [IO.Path]::GetFullPath($path)
  $suffix = @()
  while (-not (Test-Path -LiteralPath $existing)) {
    $parent = [IO.Path]::GetDirectoryName($existing)
    if (-not $parent -or $parent -eq $existing) { throw 'Cannot resolve desktop data boundary' }
    $suffix = @([IO.Path]::GetFileName($existing)) + $suffix
    $existing = $parent
  }
  try {
    $canonical = [DesktopBoundaryPath]::Resolve($existing)
  } catch {
    # A junction created by the installer (scripts\node_modules) may reject a
    # direct directory handle on some Windows builds. Resolve its target with
    # the filesystem provider before applying the boundary comparison. This
    # keeps the check fail-closed for aliases while allowing a normal install
    # to write client-homes.json.
    $item = Get-Item -LiteralPath $existing -Force -ErrorAction Stop
    $isReparsePoint = (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
    $target = @($item.Target) | Select-Object -First 1
    if (-not $isReparsePoint -or -not $target) { throw }
    if (-not [IO.Path]::IsPathRooted([string]$target)) {
      $target = Join-Path ([IO.Path]::GetDirectoryName($existing)) ([string]$target)
    }
    $canonical = Resolve-BoundaryPath ([IO.Path]::GetFullPath([string]$target))
  }
  foreach ($part in $suffix) { $canonical = Join-Path $canonical $part }
  return $canonical.TrimEnd('\')
}
function Assert-DataBoundary([string]$root) {
  $candidate = Resolve-BoundaryPath $root
  foreach ($directory in @('desktop-dist','packages','node','node_modules','scripts\node_modules')) {
    $payload = Resolve-BoundaryPath (Join-Path $AppDir $directory)
    if ($candidate.Equals($payload, [StringComparison]::OrdinalIgnoreCase) -or
        $candidate.StartsWith($payload + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw "Desktop instance root is inside the installation replacement boundary: $directory"
    }
  }
}
function Assert-Identity($identity) {
  if ($identity -isnot [pscustomobject] -or -not $identity.CAT_CAFE_DESKTOP_INSTANCE_ROOT -or
      -not [IO.Path]::IsPathRooted($identity.CAT_CAFE_DESKTOP_INSTANCE_ROOT)) { throw 'Invalid instance root' }
  Assert-DataBoundary $identity.CAT_CAFE_DESKTOP_INSTANCE_ROOT
  $ports = @($identity.FRONTEND_PORT, $identity.API_SERVER_PORT, $identity.REDIS_PORT)
  foreach ($text in $ports) {
    if ($text -notmatch '^\d+$') { throw 'Invalid isolated port' }
    $value = [int]$text
    if ($value -lt 1024 -or $value -gt 65535 -or $value -in @(3001,3002,3003,3004,6399)) { throw 'Unsafe isolated port' }
  }
  if (@($ports | ForEach-Object { [int]$_ } | Select-Object -Unique).Count -ne 3) { throw 'Ports must be distinct' }
}
$marker = Join-Path $AppDir 'desktop-instance.json'
$legacy = Join-Path $AppDir 'desktop-dist\desktop-instance.json'
$saved = $null
$body = $null
$existing = if (Test-Path -LiteralPath $marker) { $marker } elseif (Test-Path -LiteralPath $legacy) { $legacy } else { $null }
if ($existing) {
  $body = [IO.File]::ReadAllText($existing, [Text.Encoding]::UTF8)
  $saved = $body | ConvertFrom-Json
  Assert-Identity $saved
}
if ($InstanceRoot) {
  $requested = [pscustomobject]@{
    CAT_CAFE_DESKTOP_INSTANCE_ROOT = [IO.Path]::GetFullPath($InstanceRoot)
    FRONTEND_PORT = $FrontendPort
    API_SERVER_PORT = $ApiPort
    REDIS_PORT = $RedisPort
  }
  if (-not [IO.Path]::IsPathRooted($InstanceRoot)) { throw 'InstanceRoot must be absolute' }
  Assert-Identity $requested
  if ($saved) {
    foreach ($key in @('CAT_CAFE_DESKTOP_INSTANCE_ROOT','FRONTEND_PORT','API_SERVER_PORT','REDIS_PORT')) {
      if ($requested.$key -ne $saved.$key) { throw 'Explicit instance settings conflict with existing installation' }
    }
  } else { $body = $requested | ConvertTo-Json -Compress }
} elseif ($FrontendPort -or $ApiPort -or $RedisPort) { throw 'InstanceRoot is required with isolated ports' }

function Write-DefaultClientHomes([string]$root) {
  if (-not $root) { return }
  $target = Join-Path $root 'client-homes.json'
  if (Test-Path -LiteralPath $target) { return }
  $profile = if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }
  $candidates = [ordered]@{
    claude = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $profile '.claude' }
    codex = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $profile '.codex' }
    dsh = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $profile '.dsh' }
    kimi = if ($env:KIMI_CODE_HOME) { $env:KIMI_CODE_HOME } else { Join-Path $profile '.kimi-code' }
    pi = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $profile '.pi/agent' }
    npmCache = if ($env:npm_config_cache) { $env:npm_config_cache } else { Join-Path $env:LOCALAPPDATA 'npm-cache' }
  }
  $homes = [ordered]@{}
  foreach ($entry in $candidates.GetEnumerator()) {
    if ($entry.Value -and (Test-Path -LiteralPath $entry.Value -PathType Container)) {
      $homes[$entry.Key] = [IO.Path]::GetFullPath($entry.Value)
    }
  }
  if ($homes.Count -eq 0) { return }
  [IO.Directory]::CreateDirectory($root) | Out-Null
  $temporary = "$target.$PID.tmp"
  try {
    [IO.File]::WriteAllText($temporary, ($homes | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $target
  } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
}

Write-DefaultClientHomes $InstanceRoot
if (-not $body -or (Test-Path -LiteralPath $marker)) { exit 0 }
# Keep this install-owned record outside the payload replacement boundary.
# A failed extraction can be retried without losing the original instance.
[IO.Directory]::CreateDirectory($AppDir) | Out-Null
$temporary = "$marker.$PID.tmp"
try {
  [IO.File]::WriteAllText($temporary, $body, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $marker
} finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
