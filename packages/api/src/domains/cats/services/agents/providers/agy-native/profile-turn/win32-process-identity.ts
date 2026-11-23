import { execFile, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { UnixProcessIdentity } from '../../../../../../../utils/cli-process-ownership.js';
import type { ProfileTurnOwner } from './store.js';

const POWERSHELL_TIMEOUT_MS = 5_000;

function powershellArgs(script: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ];
}

function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseWin32ProcessIdentity(raw: string): UnixProcessIdentity | null {
  try {
    const parsed = JSON.parse(raw.trim()) as { pid?: unknown; startedAt?: unknown } | null;
    if (
      !parsed ||
      typeof parsed.pid !== 'number' ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.startedAt !== 'string' ||
      !parsed.startedAt.trim()
    ) {
      return null;
    }
    return { pid: parsed.pid, ppid: 0, pgid: 0, startedAt: parsed.startedAt.trim() };
  } catch {
    return null;
  }
}

function processBirthScript(pid: number): string {
  return [
    '$ErrorActionPreference = "Stop"',
    'try {',
    `  $p = [System.Diagnostics.Process]::GetProcessById(${pid})`,
    '  Write-Output (@{ pid = $p.Id; startedAt = $p.StartTime.ToUniversalTime().ToString("o") } | ConvertTo-Json -Compress)',
    '} catch {',
    '  Write-Output "null"',
    '}',
  ].join('\n');
}

function retirementCheckScript(owner: ProfileTurnOwner, home: string): string {
  const marker = owner.runHome ? `--gemini_dir=${join(owner.runHome, '.gemini')}` : `HOME=${home}`;
  return [
    '$ErrorActionPreference = "Stop"',
    `$ownerPid = ${owner.identity.pid}`,
    `$ownerStartedAt = ${psLiteral(owner.identity.startedAt)}`,
    `$marker = ${psLiteral(marker)}`,
    'try {',
    '  $p = [System.Diagnostics.Process]::GetProcessById($ownerPid)',
    '  if ($p.StartTime.ToUniversalTime().ToString("o") -eq $ownerStartedAt) {',
    '    Write-Output "ALIVE"',
    '    exit 0',
    '  }',
    '} catch {}',
    '$rows = Get-CimInstance Win32_Process -ErrorAction Stop',
    'foreach ($row in $rows) {',
    '  $cmd = $row.CommandLine',
    '  if ($cmd -and $cmd.IndexOf($marker, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {',
    '    Write-Output "DESCENDANT"',
    '    exit 0',
    '  }',
    '}',
    'Write-Output "RETIRED"',
  ].join('\n');
}

/** Windows birth-identity probe for AGY native profile turn leases. Fail-closed on error. */
export function readWin32ProcessIdentitySync(pid: number): UnixProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const result = spawnSync('powershell.exe', powershellArgs(processBirthScript(pid)), {
    encoding: 'utf8',
    timeout: POWERSHELL_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  return parseWin32ProcessIdentity(result.stdout);
}

/** Async Windows birth-identity probe so request paths do not block the event loop. */
export function readWin32ProcessIdentity(pid: number): Promise<UnixProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
  return new Promise((resolveIdentity) => {
    execFile(
      'powershell.exe',
      powershellArgs(processBirthScript(pid)),
      { encoding: 'utf8', timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error || typeof stdout !== 'string') {
          resolveIdentity(null);
          return;
        }
        resolveIdentity(parseWin32ProcessIdentity(stdout));
      },
    );
  });
}

/** Fail-closed retirement proof on Windows: requires explicit RETIRED verdict. */
export function isWin32NativeTurnRetiredSync(owner: ProfileTurnOwner, home: string): boolean {
  const result = spawnSync('powershell.exe', powershellArgs(retirementCheckScript(owner, home)), {
    encoding: 'utf8',
    timeout: POWERSHELL_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  return (
    !result.error && result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim() === 'RETIRED'
  );
}

/** Async fail-closed retirement proof on Windows. */
export function isWin32NativeTurnRetired(owner: ProfileTurnOwner, home: string): Promise<boolean> {
  return new Promise((resolveRetired) => {
    execFile(
      'powershell.exe',
      powershellArgs(retirementCheckScript(owner, home)),
      { encoding: 'utf8', timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        resolveRetired(!error && typeof stdout === 'string' && stdout.trim() === 'RETIRED');
      },
    );
  });
}
