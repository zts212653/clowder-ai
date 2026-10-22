import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export type AcpBootstrapIdentityReader = (root: string, allowUnsafeOldPath?: boolean) => string | undefined;
// Read-only handles: final target identity catches 8.3/long-name aliases. New
// roots still pass the independent non-reparse/DACL/volume verifier first.
const SCRIPT = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
$request=[Console]::In.ReadToEnd() | ConvertFrom-Json
$p=$request.path
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class AcpRootIdentity {
  [StructLayout(LayoutKind.Sequential)] public struct Info {
    public ulong Volume;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst=16)] public byte[] File;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern SafeFileHandle CreateFileW(string p, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out Info info, uint size);
}
'@
$h=[AcpRootIdentity]::CreateFileW($p,0,7,[IntPtr]::Zero,3,0x02000000,[IntPtr]::Zero)
if($h.IsInvalid) {
  $code=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if($code -eq 2 -or $code -eq 3) { [Console]::Out.Write('null'); exit 0 }
  throw "ACP directory identity unavailable (Win32 $code)"
}
try {
  if(-not $request.allowUnsafeOldPath) {
    $directory=[IO.DirectoryInfo]::new($p)
    if(-not $directory.Exists) { throw 'ACP bootstrap target is not a directory' }
    while($null -ne $directory) {
      if(($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ACP bootstrap path contains a reparse point' }
      $directory=$directory.Parent
    }
  }
  $info=[AcpRootIdentity+Info]::new()
  if(-not [AcpRootIdentity]::GetFileInformationByHandleEx($h,18,[ref]$info,24)) {
    throw "ACP directory file identity unavailable (Win32 $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
  }
  [Console]::Out.Write((($info.Volume.ToString('X16')+':'+[BitConverter]::ToString($info.File)) | ConvertTo-Json -Compress))
} finally { $h.Dispose() }
`;

export const readAcpBootstrapRootIdentity: AcpBootstrapIdentityReader = (root, allowUnsafeOldPath = false) => {
  const output = execFileSync(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
    {
      input: JSON.stringify({ path: root, allowUnsafeOldPath }),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH')),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const value: unknown = JSON.parse(output);
  if (value === null) return undefined;
  if (typeof value !== 'string' || !/^[A-F0-9]{16}:(?:[A-F0-9]{2}-){15}[A-F0-9]{2}$/.test(value))
    throw new Error('ACP directory identity result is invalid');
  return value;
};
