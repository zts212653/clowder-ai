import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const systemProxy = z.object({ enabled: z.boolean(), proxyOverride: z.string(), hasPac: z.boolean() });
export type WindowsSystemProxy = z.infer<typeof systemProxy>;

// Adapted from #1670's read-windows-wpad-state.ps1. Keep the query bundled with
// the reader so installed dist builds do not depend on a source-only script.
const query = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CodexProxyQuery {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Config {
        [MarshalAs(UnmanagedType.Bool)] public bool autoDetect;
        public IntPtr pac, proxy, bypass;
    }
    [DllImport("winhttp.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool WinHttpGetIEProxyConfigForCurrentUser(ref Config config);
    [DllImport("kernel32.dll")] public static extern IntPtr GlobalFree(IntPtr value);
}
"@
$settings = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
if ($settings.ProxyEnable -notin @(0, 1)) { throw 'unknown_manual_proxy_state' }
$config = New-Object CodexProxyQuery+Config
if (-not [CodexProxyQuery]::WinHttpGetIEProxyConfigForCurrentUser([ref]$config)) { throw 'unknown_automatic_proxy_state' }
try {
    $pac = $config.pac -ne [IntPtr]::Zero -and [Runtime.InteropServices.Marshal]::PtrToStringUni($config.pac)
    @{
        enabled = $settings.ProxyEnable -eq 1
        proxyOverride = [string]$settings.ProxyOverride
        hasPac = [bool]($config.autoDetect -or $pac -or $settings.AutoConfigURL)
    } | ConvertTo-Json -Compress
} finally {
    @($config.pac, $config.proxy, $config.bypass) | ForEach-Object {
        if ($_ -ne [IntPtr]::Zero) { [CodexProxyQuery]::GlobalFree($_) | Out-Null }
    }
}
`;

/** Read-only, bounded observation. Unknown/PAC states never become an empty bypass list. */
export async function readWindowsSystemProxy(): Promise<WindowsSystemProxy | null> {
  try {
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', query],
      { timeout: 1000, maxBuffer: 32 * 1024, windowsHide: true },
    );
    const parsed = systemProxy.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
