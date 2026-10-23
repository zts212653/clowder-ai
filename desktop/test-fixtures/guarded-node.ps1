# Test-only: enable enforcement in this disposable process; never change a system policy.
param([string]$NodeExe, [string]$Worker)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RedirectionGuardAcceptance {
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessMitigationPolicy(IntPtr process, int policy, out uint flags, int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetProcessMitigationPolicy(int policy, ref uint flags, int size);
  public static uint Read(IntPtr process) {
    uint flags;
    if (!GetProcessMitigationPolicy(process, 16, out flags, 4)) throw new System.ComponentModel.Win32Exception();
    return flags;
  }
  public static uint Enable() {
    uint flags = Read(GetCurrentProcess()) | 1;
    if (!SetProcessMitigationPolicy(16, ref flags, 4)) throw new System.ComponentModel.Win32Exception();
    return Read(GetCurrentProcess());
  }
}
'@
$enforced = [RedirectionGuardAcceptance]::Enable()
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $NodeExe
$start.Arguments = '"' + $Worker + '" verify'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$child = [Diagnostics.Process]::Start($start)
$childFlags = [RedirectionGuardAcceptance]::Read($child.Handle)
if (-not $child.WaitForExit(75000)) {
  $child.Kill($true)
  $child.WaitForExit()
  throw 'Owned guarded worker exceeded its acceptance budget'
}
if (($enforced -band 1) -ne 1 -or ($childFlags -band 1) -ne 1) { throw 'RedirectionGuard enforcement was not inherited' }
if ($child.ExitCode -ne 0) { throw "Guarded acceptance worker failed: $($child.ExitCode)" }
Write-Output "Guard enforced; parentFlags=$enforced; child=$($child.Id); flags=$childFlags; exit=$($child.ExitCode)"
$child.Dispose()
