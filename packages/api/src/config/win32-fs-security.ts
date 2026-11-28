import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { powershellArgs } from '../utils/windows-job-native.js';

const SECURITY_TOOL_TIMEOUT_MS = 10_000;
const SID_SYSTEM = 'S-1-5-18';
const SID_ADMINISTRATORS = 'S-1-5-32-544';
const SID_CREATOR_OWNER = 'S-1-3-0';
const SID_PATTERN = /^S-\d+(?:-\d+)+$/;
const SHA256_HEX = /^[a-f0-9]{64}$/i;

export interface Win32DirectoryAclSnapshot {
  readonly currentUserSid: string;
  readonly ownerSid: string;
  readonly allowSids: readonly string[];
}

let cachedCurrentUserSid: string | undefined;

/**
 * Escape a PowerShell single-quoted string literal across all five Windows PowerShell 5.1
 * single-quote delimiters: ASCII `'` (U+0027) and Unicode curly single quotes
 * `‘` (U+2018), `’` (U+2019), `‚` (U+201A), and `‛` (U+201B).
 */
export function escapePowerShellSingleQuotedLiteral(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`;
}

function normalizeWin32Path(path: string): string {
  return resolve(path).replaceAll('/', '\\').toLowerCase();
}

/**
 * Expand Windows 8.3 short path segments (such as `RUNNER~1` -> `runneradmin`) to match
 * the long NTFS volume-relative paths returned by `fsutil hardlink list` and `FindFirstFileNameW`.
 */
export function canonicalWin32Path(path: string): string {
  return typeof realpathSync.native === 'function' ? realpathSync.native(path) : realpathSync(path);
}

export function windowsPowerShellPath(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Strip inherited PSModulePath when invoking Windows PowerShell 5.1 so a parent
 * PowerShell 7 (`pwsh`) shell (such as GitHub Actions windows-latest) cannot
 * poison .NET Framework 4.8 module loading.
 */
export function windowsPowerShellEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'));
}

function getCurrentWin32UserSid(): string | null {
  if (cachedCurrentUserSid) return cachedCurrentUserSid;
  const whoami = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    timeout: SECURITY_TOOL_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 16 * 1024,
  });
  if (!whoami.error && whoami.status === 0 && typeof whoami.stdout === 'string') {
    const match = whoami.stdout.match(/"(S-\d+(?:-\d+)+)"/);
    if (match?.[1]) {
      cachedCurrentUserSid = match[1];
      return cachedCurrentUserSid;
    }
  }
  const ps = spawnSync(
    windowsPowerShellPath(),
    powershellArgs(
      "$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    ),
    {
      encoding: 'utf8',
      timeout: SECURITY_TOOL_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 16 * 1024,
      env: windowsPowerShellEnv(),
    },
  );
  if (!ps.error && ps.status === 0 && typeof ps.stdout === 'string') {
    const sid = ps.stdout.replace(/^\uFEFF/, '').trim();
    if (SID_PATTERN.test(sid)) {
      cachedCurrentUserSid = sid;
      return cachedCurrentUserSid;
    }
  }
  return null;
}

/**
 * Pure ACL evaluator: a private Windows directory must be owned by the current user,
 * SYSTEM, or Administrators, and must NOT grant Allow access to any other principal
 * (such as Everyone S-1-1-0, Authenticated Users S-1-5-11, Users S-1-5-32-545, or another user).
 */
export function isWin32AclSnapshotPrivate(snapshot: Win32DirectoryAclSnapshot | null): boolean {
  if (!snapshot) return false;
  if (!SID_PATTERN.test(snapshot.currentUserSid) || !SID_PATTERN.test(snapshot.ownerSid)) return false;
  const allowedOwners = new Set([snapshot.currentUserSid, SID_SYSTEM, SID_ADMINISTRATORS]);
  if (!allowedOwners.has(snapshot.ownerSid)) return false;
  const allowedPrincipals = new Set([snapshot.currentUserSid, SID_SYSTEM, SID_ADMINISTRATORS, SID_CREATOR_OWNER]);
  for (const sid of snapshot.allowSids) {
    if (!SID_PATTERN.test(sid) || !allowedPrincipals.has(sid)) return false;
  }
  return true;
}

function inspectWin32DirectoryAcls(dirs: readonly string[]): (Win32DirectoryAclSnapshot | null)[] | null {
  if (dirs.length === 0) return [];
  const items = dirs.map(escapePowerShellSingleQuotedLiteral).join(', ');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$sidType = [System.Security.Principal.SecurityIdentifier]',
    '$allow = [System.Security.AccessControl.AccessControlType]::Allow',
    '$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    `$paths = @(${items})`,
    '$results = @()',
    'foreach ($target in $paths) {',
    '  try {',
    '    $acl = [System.IO.Directory]::GetAccessControl($target)',
    '    $ownerSid = $acl.GetOwner($sidType).Value',
    '    $seen = [System.Collections.Generic.HashSet[string]]::new()',
    '    foreach ($rule in $acl.GetAccessRules($true, $true, $sidType)) {',
    '      if ($rule.AccessControlType -eq $allow) {',
    '        [void]$seen.Add($rule.IdentityReference.Value)',
    '      }',
    '    }',
    '    $results += [ordered]@{ currentUserSid = $me; ownerSid = $ownerSid; allowSids = @($seen) }',
    '  } catch {',
    '    $results += $null',
    '  }',
    '}',
    'ConvertTo-Json -InputObject $results -Compress -Depth 4',
  ].join('\n');
  const result = spawnSync(windowsPowerShellPath(), powershellArgs(script), {
    encoding: 'utf8',
    timeout: SECURITY_TOOL_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 256 * 1024,
    env: windowsPowerShellEnv(),
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  try {
    const parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (list.length !== dirs.length) return null;
    return list.map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const obj = entry as Record<string, unknown>;
      if (typeof obj.currentUserSid !== 'string' || typeof obj.ownerSid !== 'string') return null;
      const rawSids = Array.isArray(obj.allowSids)
        ? obj.allowSids
        : typeof obj.allowSids === 'string'
          ? [obj.allowSids]
          : null;
      if (!rawSids) return null;
      const allowSids = rawSids.filter((v): v is string => typeof v === 'string');
      if (allowSids.length !== rawSids.length) return null;
      return { currentUserSid: obj.currentUserSid, ownerSid: obj.ownerSid, allowSids };
    });
  } catch {
    return null;
  }
}

/**
 * Harden a newly created private Windows directory by disabling inheritance and granting
 * full control ONLY to SYSTEM, Administrators, and the current user SID (locale-independent).
 */
export function hardenWin32PrivateDirectoryAcl(dir: string): void {
  if (process.platform !== 'win32') return;
  const userSid = getCurrentWin32UserSid();
  if (!userSid) throw new Error('agy_account_directory_unsafe');
  const result = spawnSync(
    'icacls.exe',
    [
      dir,
      '/inheritance:r',
      '/grant:r',
      `*${SID_SYSTEM}:(OI)(CI)F`,
      '/grant:r',
      `*${SID_ADMINISTRATORS}:(OI)(CI)F`,
      '/grant:r',
      `*${userSid}:(OI)(CI)F`,
    ],
    {
      encoding: 'utf8',
      timeout: SECURITY_TOOL_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    },
  );
  if (result.error || result.status !== 0) throw new Error('agy_account_directory_unsafe');
}

/**
 * Verify every Windows directory in `dirs` has a private DACL & safe owner.
 * Fail-closed on any query/parsing error. No-op (returns true) off Windows.
 */
export function areWin32DirectoriesAclPrivate(dirs: readonly string[]): boolean {
  if (process.platform !== 'win32') return true;
  if (dirs.length === 0) return true;
  const snapshots = inspectWin32DirectoryAcls(dirs);
  if (!snapshots || snapshots.length !== dirs.length) return false;
  return snapshots.every((snapshot) => isWin32AclSnapshotPrivate(snapshot));
}

const HARDLINK_ENUM_INTEROP = `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class ClowderHardlinkInterop {
  static readonly IntPtr INVALID_HANDLE = new IntPtr(-1);
  const int ERROR_MORE_DATA = 234;
  const int ERROR_HANDLE_EOF = 38;

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr FindFirstFileNameW(string lpFileName, uint dwFlags, ref uint stringLength, StringBuilder linkName);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool FindNextFileNameW(IntPtr hFindStream, ref uint stringLength, StringBuilder linkName);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool FindClose(IntPtr hFindFile);

  public static string[] ListLinks(string path) {
    var results = new List<string>();
    uint len = 512;
    var sb = new StringBuilder((int)len);
    IntPtr handle = FindFirstFileNameW(path, 0, ref len, sb);
    if (handle == INVALID_HANDLE && Marshal.GetLastWin32Error() == ERROR_MORE_DATA) {
      sb = new StringBuilder((int)len);
      handle = FindFirstFileNameW(path, 0, ref len, sb);
    }
    if (handle == INVALID_HANDLE) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      results.Add(sb.ToString());
      while (true) {
        len = 512;
        sb.Clear();
        sb.EnsureCapacity((int)len);
        if (!FindNextFileNameW(handle, ref len, sb)) {
          int err = Marshal.GetLastWin32Error();
          if (err == ERROR_MORE_DATA) {
            sb = new StringBuilder((int)len);
            if (!FindNextFileNameW(handle, ref len, sb)) {
              err = Marshal.GetLastWin32Error();
              if (err == ERROR_HANDLE_EOF) break;
              throw new System.ComponentModel.Win32Exception(err);
            }
          } else if (err == ERROR_HANDLE_EOF) {
            break;
          } else {
            throw new System.ComponentModel.Win32Exception(err);
          }
        }
        results.Add(sb.ToString());
      }
    } finally {
      FindClose(handle);
    }
    return results.ToArray();
  }
}
'@
`;

const ASCII_ONLY = /^[\x20-\x7E]+$/;
const ASCII_LINES = /^[\r\n\x20-\x7E]+$/;

/**
 * Enumerate every NTFS hardlink path for `filePath` as volume-relative paths.
 * Fast-paths pure-ASCII paths via `fsutil.exe hardlink list` (~30ms, no admin needed),
 * falling back to Win32 `FindFirstFileNameW`/`FindNextFileNameW` for non-ASCII Unicode paths.
 */
export function listWin32Hardlinks(filePath: string): string[] | null {
  if (process.platform !== 'win32') return null;
  if (ASCII_ONLY.test(filePath)) {
    const fsutil = spawnSync('fsutil.exe', ['hardlink', 'list', filePath], {
      encoding: 'utf8',
      timeout: SECURITY_TOOL_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    if (!fsutil.error && fsutil.status === 0 && typeof fsutil.stdout === 'string' && ASCII_LINES.test(fsutil.stdout)) {
      const lines = fsutil.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('\\'));
      if (lines.length > 0) return lines;
    }
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    HARDLINK_ENUM_INTEROP,
    `$links = [ClowderHardlinkInterop]::ListLinks(${escapePowerShellSingleQuotedLiteral(filePath)})`,
    'ConvertTo-Json -InputObject @($links) -Compress',
  ].join('\n');
  const result = spawnSync(windowsPowerShellPath(), powershellArgs(script), {
    encoding: 'utf8',
    timeout: SECURITY_TOOL_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 256 * 1024,
    env: windowsPowerShellEnv(),
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  try {
    const parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()) as unknown;
    const list = Array.isArray(parsed) ? parsed : typeof parsed === 'string' ? [parsed] : null;
    if (!list) return null;
    const links = list.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    return links.length === list.length ? links : null;
  } catch {
    return null;
  }
}

/**
 * Verify that every NTFS hardlink on `filePath` is either the canonical `filePath` itself
 * or an explicitly permitted controlled alias. Fails closed on any enumeration error or
 * unexpected extra hardlink. Fast-paths `nlink === 1` without spawning any subprocess.
 */
export function hasOnlyControlledWin32Hardlinks(
  filePath: string,
  isAllowedAlias: (fullAliasPath: string) => boolean,
  options: {
    readonly listLinks?: (path: string) => string[] | null;
    readonly expectedNlink?: number;
  } = {},
): boolean {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  const nlink = options.expectedNlink ?? stat.nlink;
  if (nlink === 1) return true;
  if (nlink < 1) return false;
  if (process.platform !== 'win32' && !options.listLinks) return false;

  let canonical: string;
  try {
    canonical = canonicalWin32Path(filePath);
  } catch {
    return false;
  }
  const driveMatch = canonical.match(/^([A-Za-z]:)\\/);
  if (!driveMatch) return false;
  const drivePrefix = driveMatch[1];

  const volumeRelativeLinks = (options.listLinks ?? listWin32Hardlinks)(canonical);
  if (!volumeRelativeLinks || volumeRelativeLinks.length < nlink) return false;

  const normalizedCanonical = normalizeWin32Path(canonical);
  let sawCanonical = false;
  for (const rel of volumeRelativeLinks) {
    if (!rel.startsWith('\\')) return false;
    const fullPath = `${drivePrefix}${rel}`;
    if (normalizeWin32Path(fullPath) === normalizedCanonical) {
      sawCanonical = true;
      continue;
    }
    if (!isAllowedAlias(fullPath)) return false;
  }
  return sawCanonical;
}

/**
 * Controlled alias predicate for an AGY account's canonical OAuth token file on Windows:
 * every hardlink outside `agyOAuthFile(account)` MUST be `<profileHome>\.cat-cafe-account-views\<sha256(account)>\antigravity-oauth-token`
 * inside a non-symlink private view directory.
 */
export function isControlledAgyOAuthAlias(
  accountCanonicalHome: string,
  fileName: string,
): (fullPath: string) => boolean {
  const hashes = new Set<string>([createHash('sha256').update(accountCanonicalHome).digest('hex').toLowerCase()]);
  try {
    hashes.add(createHash('sha256').update(canonicalWin32Path(accountCanonicalHome)).digest('hex').toLowerCase());
  } catch {
    // Keep caller hash if the directory cannot be re-resolved on this platform.
  }
  const suffixes = [...hashes].map((hash) => `\\.cat-cafe-account-views\\${hash}\\${fileName.toLowerCase()}`);
  return (fullPath: string): boolean => {
    const normalized = normalizeWin32Path(fullPath);
    if (!suffixes.some((suffix) => normalized.endsWith(suffix))) return false;
    const viewDir = dirname(fullPath);
    const viewsDir = dirname(viewDir);
    try {
      const viewStat = lstatSync(viewDir);
      const viewsStat = lstatSync(viewsDir);
      if (
        !viewStat.isDirectory() ||
        viewStat.isSymbolicLink() ||
        !viewsStat.isDirectory() ||
        viewsStat.isSymbolicLink()
      ) {
        return false;
      }
      return areWin32DirectoriesAclPrivate([viewsDir, viewDir]);
    } catch {
      return false;
    }
  };
}

/**
 * Controlled alias predicate for a member profile's shared session file on Windows:
 * every hardlink outside `profileHome/.gemini/antigravity-cli/<name>` MUST live under
 * `profileHome/.cat-cafe-account-views/<64-hex-hash>/<name>`.
 */
export function isControlledAgySharedFileAlias(
  profileCanonicalHome: string,
  fileName: string,
): (fullPath: string) => boolean {
  let resolvedProfile = profileCanonicalHome;
  try {
    resolvedProfile = canonicalWin32Path(profileCanonicalHome);
  } catch {
    // Keep caller path if not resolvable on this platform.
  }
  const viewsRoot = normalizeWin32Path(join(resolvedProfile, '.cat-cafe-account-views'));
  const expectedFile = fileName.toLowerCase();
  return (fullPath: string): boolean => {
    const normalized = normalizeWin32Path(fullPath);
    if (!normalized.startsWith(`${viewsRoot}\\`)) return false;
    const remainder = normalized.slice(viewsRoot.length + 1);
    const parts = remainder.split('\\');
    return parts.length === 2 && SHA256_HEX.test(parts[0] ?? '') && parts[1] === expectedFile;
  };
}
