const { execFile } = require('node:child_process');
const path = require('node:path');

function readWindowsPath(signal) {
  // Ask Windows for the current user's normal environment without inheriting
  // the installer's stale variables. Only PATH leaves this helper process.
  const command = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class ClowderUserEnvironment {
  [DllImport("userenv.dll", SetLastError = true)]
  public static extern bool CreateEnvironmentBlock(out IntPtr block, IntPtr token, bool inherit);
  [DllImport("userenv.dll")]
  public static extern bool DestroyEnvironmentBlock(IntPtr block);
  public static string ReadPath() {
    using (var identity = WindowsIdentity.GetCurrent()) {
      IntPtr block;
      if (!CreateEnvironmentBlock(out block, identity.Token, false)) throw new Win32Exception();
      try {
        var cursor = block;
        string entry;
        while (!String.IsNullOrEmpty(entry = Marshal.PtrToStringUni(cursor))) {
          if (entry.StartsWith("Path=", StringComparison.OrdinalIgnoreCase)) return entry.Substring(5);
          cursor = IntPtr.Add(cursor, (entry.Length + 1) * 2);
        }
        return null;
      } finally { DestroyEnvironmentBlock(block); }
    }
  }
}
'@
$paths = @{ normalPath = [ClowderUserEnvironment]::ReadPath() } | ConvertTo-Json -Compress
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($paths))`;
  return new Promise((resolve) => {
    execFile(
      path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', timeout: 8000, windowsHide: true, signal },
      (error, stdout) => {
        if (error || !stdout.trim()) return resolve(null);
        // Validate the subprocess response once at this boundary.
        try {
          const paths = JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8'));
          resolve(typeof paths?.normalPath === 'string' && paths.normalPath.trim() ? paths.normalPath : null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

function mergeWindowsPath(env, normalPath) {
  if (!normalPath) return env;
  const pathKeys = Object.keys(env)
    .filter((key) => key.toUpperCase() === 'PATH')
    .sort();
  const pathKey = pathKeys[0] ?? 'Path';
  const inheritedPath = env[pathKey] ?? '';
  const normalize = (entry) =>
    entry
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .replaceAll('/', '\\')
      .replace(/\\+$/, '')
      .toLowerCase();
  const inherited = inheritedPath ? inheritedPath.split(';') : [];
  const inheritedKeys = inherited.map(normalize);
  const seen = new Set(inheritedKeys);
  const merged = [];
  let cursor = 0;
  let missing = [];
  normalPath
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const key = normalize(entry);
      // Match occurrences only after the last anchor. A directory explicitly
      // moved earlier by the parent cannot anchor a later missing segment.
      const anchor = inheritedKeys.indexOf(key, cursor);
      if (anchor !== -1) {
        merged.push(...inherited.slice(cursor, anchor), ...missing, inherited[anchor]);
        cursor = anchor + 1;
        missing = [];
      } else if (!seen.has(key)) {
        missing.push(entry);
        seen.add(key);
      }
    });
  merged.push(...inherited.slice(cursor), ...missing);
  if (merged.length !== inherited.length) env[pathKey] = merged.join(';');
  // Node forwards the first case-insensitive key in lexical order on Windows.
  pathKeys.slice(1).forEach((key) => {
    delete env[key];
  });
  return env;
}

module.exports = { readWindowsPath, mergeWindowsPath };
