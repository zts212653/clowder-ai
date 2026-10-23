param(
  [Parameter(Mandatory)] [string]$AppDir,
  [string]$InstanceRoot,
  [switch]$InspectOnly,
  [ValidateRange(0,15)] [int]$WaitSeconds = 15
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $AppDir)) { exit 0 }
# Resolve junction/8.3 spellings by filesystem handle, retaining the directory boundary.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class InstallPathIdentity {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder result, uint size, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int processId);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool QueryFullProcessImageName(SafeProcessHandle process, uint flags, StringBuilder result, ref uint size);
  public static string ProcessImage(int processId) {
    using (var process = OpenProcess(0x1000, false, processId)) {
      if (process.IsInvalid) throw new System.ComponentModel.Win32Exception();
      var text = new StringBuilder(32768);
      uint size = (uint)text.Capacity;
      if (!QueryFullProcessImageName(process, 0, text, ref size)) throw new System.ComponentModel.Win32Exception();
      return text.ToString();
    }
  }
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
$installRoot = [InstallPathIdentity]::Resolve($AppDir).TrimEnd('\')
$installPrefix = $installRoot + '\'
# Names narrow enumeration only; canonical executable paths remain the stop authority.
# Do not traverse reparse members into another installation or user-owned tree.
function Get-InstallExecutableNames {
  $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $directories = [Collections.Generic.Queue[string]]::new()
  $directories.Enqueue($installRoot)
  while ($directories.Count -gt 0) {
    foreach ($entry in @(Get-ChildItem -LiteralPath $directories.Dequeue() -Force -ErrorAction Stop)) {
      if ($entry.PSIsContainer) {
        if (-not ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $directories.Enqueue($entry.FullName) }
      }
      elseif ($entry.Extension -ieq '.exe') { $null = $names.Add($entry.BaseName) }
    }
  }
  return ,$names
}
$candidateNames = Get-InstallExecutableNames
function Test-CandidateStillRunning([int]$ProcessId) {
  $current = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $current) { return $false }
  # Enumeration can retain an exited process; presence alone is not liveness.
  try { return (-not $current.HasExited) }
  catch { return $true } # An unknown live candidate must still refuse shutdown.
}
function Get-OwnedInstallProcesses {
  foreach ($candidate in @(Get-Process -ErrorAction Stop)) {
    # Querying paths of unrelated protected Windows processes can fail even for an administrator.
    # An unreadable live candidate is still an error, never evidence of a stopped installation.
    try {
      $processName = $candidate.ProcessName
      if (-not $processName) { throw 'Process name unavailable' }
    } catch {
      if (Test-CandidateStillRunning $candidate.Id) {
        throw "Cannot verify process identity for installation shutdown (PID $($candidate.Id))"
      }
      continue
    }
    if (-not $candidateNames.Contains($processName)) { continue }
    try {
      # Module enumeration can fail for an unrelated elevated process under the original user token.
      $processPath = [InstallPathIdentity]::ProcessImage($candidate.Id)
      if (-not $processPath) { throw 'Executable path unavailable' }
      $processPath = [InstallPathIdentity]::Resolve($processPath)
    } catch {
      if (Test-CandidateStillRunning $candidate.Id) {
        throw "Cannot verify candidate executable for installation shutdown (PID $($candidate.Id))"
      }
      continue
    }
    if ($processPath.StartsWith($installPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-CandidateStillRunning $candidate.Id)) { $candidate }
  }
}
if ($InspectOnly) {
  @(Get-OwnedInstallProcesses | ForEach-Object { $_.Id }) | ConvertTo-Json -Compress
  exit 0
}
function Test-ArchivedLifecycle {
  $archive = Join-Path $installRoot 'desktop-dist\resources\app.asar'
  if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { return $false }
  $reader = $null
  $stream = $null
  try {
    # Read only the bounded Chromium Pickle directory, never execute archive code.
    $stream = [IO.File]::OpenRead($archive)
    $reader = [IO.BinaryReader]::new($stream)
    $size = $reader.ReadBytes(8)
    if ($size.Length -ne 8 -or [BitConverter]::ToUInt32($size,0) -ne 4) { return $false }
    $length = [BitConverter]::ToUInt32($size,4)
    if ($length -lt 8 -or $length -gt 2097152 -or $length -gt $stream.Length - 8) { return $false }
    $buffer = $reader.ReadBytes([int]$length)
    if ($buffer.Length -ne $length) { return $false }
    $payload = [BitConverter]::ToUInt32($buffer,0)
    $textLength = [BitConverter]::ToUInt32($buffer,4)
    if ($payload -lt 4 -or $payload -gt $length - 4 -or $textLength -gt $payload - 4) { return $false }
    $header = [Text.UTF8Encoding]::new($false,$true).GetString($buffer,8,[int]$textLength) | ConvertFrom-Json
    $entry = $header.files.'installation-lifecycle.js'
    if (-not $entry -or $entry.unpacked -or $entry.PSObject.Properties.Name -contains 'link') { return $false }
    if (($entry.size -isnot [int] -and $entry.size -isnot [long]) -or $entry.size -le 0) { return $false }
    $offset = [long]0
    if ([string]$entry.offset -notmatch '^\d+$' -or -not [long]::TryParse([string]$entry.offset,[ref]$offset)) { return $false }
    return ($offset -le $stream.Length - 8 - $length -and $entry.size -le $stream.Length - 8 - $length - $offset)
  } catch { return $false }
  finally {
    if ($reader) { $reader.Dispose() } elseif ($stream) { $stream.Dispose() }
  }
}
$exe = Join-Path $installRoot 'desktop-dist\Clowder AI.exe'
$marker = Join-Path $installRoot 'desktop-instance.json'
if (-not (Test-Path -LiteralPath $marker)) { $marker = Join-Path $installRoot 'desktop-dist\desktop-instance.json' }
$supported = Join-Path $installRoot 'desktop-dist\resources\app\installation-lifecycle.js'
if (-not (Test-Path -LiteralPath $supported)) {
  $supported = Join-Path $installRoot 'desktop-dist\resources\app.asar.unpacked\installation-lifecycle.js'
}
# An isolated upgrade without a persistent marker cannot use the default lock.
if ((Test-Path -LiteralPath $exe) -and ((Test-Path -LiteralPath $supported) -or (Test-ArchivedLifecycle)) -and (-not $InstanceRoot -or (Test-Path -LiteralPath $marker))) {
  Start-Process -FilePath $exe -ArgumentList '--quit-owned-installation' -WindowStyle Hidden
}
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  if (@(Get-OwnedInstallProcesses).Count -eq 0) { exit 0 }
  Start-Sleep -Milliseconds 250
}
# Bounded cleanup is restricted to executables within this exact installation.
$ownedProcesses = @(Get-OwnedInstallProcesses)
if ($ownedProcesses.Count -gt 0) {
  $ownedProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
  # Stop-Process requests termination; wait on the same captured objects before re-enumerating.
  Wait-Process -InputObject $ownedProcesses -Timeout 5 -ErrorAction SilentlyContinue
}
if (@(Get-OwnedInstallProcesses).Count -ne 0) { exit 1 }
