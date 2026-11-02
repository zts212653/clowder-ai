import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';
import type { WindowsAcpBootstrapOptions } from '../acp-bootstrap-windows-directory.js';
import { isWindowsAcpAncestorFailure } from './acp-bootstrap-windows-error.js';

export interface WindowsAcpRootOptions extends WindowsAcpBootstrapOptions {
  /** Unit-test injection; every returned candidate still goes through the native verifier. */
  volumeRoots?: () => string[];
}
export type WindowsBootstrapEnsurer = (root: string, cwd: string, options?: WindowsAcpBootstrapOptions) => void;

function volumeRoots(): string[] {
  const script = `
    $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
    $roots = @([IO.DriveInfo]::GetDrives() | Where-Object {
      $_.IsReady -and $_.DriveType -eq 'Fixed' -and $_.DriveFormat -eq 'NTFS' -and
      $_.Name.TrimEnd('\\') -ne $env:SystemDrive
    } | ForEach-Object { $_.Name })
    @{sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; roots=$roots} | ConvertTo-Json -Compress
  `;
  const output = execFileSync(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH')),
    },
  );
  const value: unknown = JSON.parse(output);
  if (
    !value ||
    typeof value !== 'object' ||
    !('sid' in value) ||
    typeof value.sid !== 'string' ||
    !/^S-[0-9-]+$/.test(value.sid) ||
    !('roots' in value) ||
    !Array.isArray(value.roots)
  ) {
    throw new Error('Windows ACP volume discovery returned an invalid receipt');
  }
  const owner = createHash('sha256').update(value.sid).digest('hex').slice(0, 16);
  return value.roots
    .filter((root): root is string => typeof root === 'string' && /^[A-Za-z]:\\$/.test(root))
    .slice(0, 8)
    .map((root) => win32.join(root, `cat-cafe-acp-bootstrap-sid-${owner}`));
}

export function ensureWindowsAcpBootstrapRoot(
  primary: string,
  leaf: string,
  ensure: WindowsBootstrapEnsurer,
  fallback: string | undefined,
  allowFallback: boolean,
  options: WindowsAcpRootOptions,
): string {
  const rejected: string[] = [];
  const attempt = (root: string): boolean => {
    try {
      ensure(root, join(root, leaf), options);
      return true;
    } catch (error) {
      if (!allowFallback || !isWindowsAcpAncestorFailure(error)) throw error;
      rejected.push(`${root}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  if (attempt(primary)) return primary;
  if (fallback && win32.resolve(fallback) !== win32.resolve(primary)) {
    // Preserve the established ProgramData layout. These non-sensitive containers
    // are checked by the same verifier before a private root can be admitted.
    mkdirSync(dirname(fallback), { recursive: true });
    if (attempt(fallback)) {
      console.warn(`[acp] Windows ACP bootstrap relocated to ${fallback}; rejected ${rejected.join('; ')}`);
      return fallback;
    }
  }
  // Discovery is not an exemption: unknown clients keep every strict ACL check.
  for (const candidate of (options.volumeRoots ?? volumeRoots)()) {
    if (attempt(candidate)) {
      console.warn(`[acp] Windows ACP bootstrap relocated to ${candidate}; rejected ${rejected.join('; ')}`);
      return candidate;
    }
  }
  throw new Error(`No trusted Windows ACP bootstrap root: ${rejected.join('; ')}`);
}
