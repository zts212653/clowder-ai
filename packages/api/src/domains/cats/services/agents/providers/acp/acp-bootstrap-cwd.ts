import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, type PlatformPath, posix, relative, resolve, win32 } from 'node:path';
import { ensureWindowsAcpBootstrapDirectories } from './acp-bootstrap-windows-directory.js';

const SAFE_SEGMENT_RE = /[^a-zA-Z0-9._-]+/g;
const OWNER_ONLY_MODE = 0o700;

function sanitizeSegment(value: string, fallback: string): string {
  const sanitized = value.replace(SAFE_SEGMENT_RE, '-').replace(/^-+|-+$/g, '');
  return sanitized || fallback;
}

function isExplicitRelativePath(value: string): boolean {
  return value.startsWith('./') || value.startsWith('../') || value.startsWith('.\\') || value.startsWith('..\\');
}

function isPathLikeArgValue(value: string): boolean {
  return isExplicitRelativePath(value) || /[\\/]/.test(value) || /\.[^./\\]+$/.test(value);
}

function bootstrapOwnerSegment(): string {
  if (typeof process.getuid === 'function') {
    return `uid-${process.getuid()}`;
  }
  try {
    return `user-${sanitizeSegment(userInfo().username, 'unknown')}`;
  } catch {
    const fallback = process.env.USERNAME ?? process.env.USER ?? 'unknown';
    return `user-${sanitizeSegment(fallback, 'unknown')}`;
  }
}

/**
 * Unix uses stable /tmp (→ /private/tmp on macOS); Windows uses user temp.
 *
 * macOS periodically cleans os.tmpdir() (/var/folders/.../T/) during runtime —
 * when the bootstrap CWD is deleted while a CLI process idles, the next prompt
 * fails with os.getcwd() → FileNotFoundError → ACP -32603. /tmp is only
 * cleaned on reboot, so idle processes survive between reboots.
 */
export function resolveAcpBootstrapRoot(platform: NodeJS.Platform = process.platform, tempRoot = tmpdir()): string {
  const pathApi = platform === 'win32' ? win32 : posix;
  return pathApi.join(platform === 'win32' ? tempRoot : '/tmp', `cat-cafe-acp-bootstrap-${bootstrapOwnerSegment()}`);
}

/**
 * Machine-local fallback for Windows profiles whose temp ACLs were modified by
 * another tool (a sandbox group or sibling user holding Modify/Delete on the
 * profile ancestors). ProgramData stays trusted on default Windows installs and
 * the fallback root receives the same protected owner-only DACL, so privacy is
 * unchanged — only the ancestor chain that cannot be replaced differs.
 */
export function resolveWindowsAcpBootstrapFallbackRoot(
  platform: NodeJS.Platform = process.platform,
  programData = process.env.ProgramData ?? process.env.ALLUSERSPROFILE ?? '',
): string | undefined {
  if (platform !== 'win32') return undefined;
  const base = programData.trim();
  if (!base) return undefined;
  return win32.join(base, 'ClowderAI', 'acp-bootstrap', `cat-cafe-acp-bootstrap-${bootstrapOwnerSegment()}`);
}

type WindowsBootstrapEnsurer = (root: string, cwd: string) => void;

export function isPathWithinRoot(
  rootPath: string,
  candidatePath: string,
  pathApi: Pick<PlatformPath, 'relative' | 'isAbsolute'>,
): boolean {
  const rel = pathApi.relative(rootPath, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !pathApi.isAbsolute(rel));
}

function assertRealDirectory(path: string, kind: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`${kind} must not be a symlink: ${path}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${kind} must be a directory: ${path}`);
  }
}

function enforceOwnerOnlyPermissions(path: string): void {
  try {
    chmodSync(path, OWNER_ONLY_MODE);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOSYS' && code !== 'EPERM') {
      throw err;
    }
  }
}

/**
 * Gemini ACP initialize is sensitive to project-level .gemini/settings.json when
 * launched directly from repo cwd. Bootstrap from an isolated tmp dir, then pass
 * the real project cwd + MCP servers later via session/new.
 */
export function resolveAcpBootstrapCwd(
  projectRoot: string,
  providerProfile: string,
  // #1203: Test-isolation injection point — tests pass a throwaway root so
  // their fixtures and cleanup never touch the uid-shared production root.
  bootstrapRoot: string = resolveAcpBootstrapRoot(),
  windowsEnsure: WindowsBootstrapEnsurer = ensureWindowsAcpBootstrapDirectories,
  windowsFallbackRoot: string | undefined = resolveWindowsAcpBootstrapFallbackRoot(),
  // Only the production default root may relocate. Callers that inject a root
  // (tests, isolated fixtures) keep the fail-closed contract they assert.
  allowWindowsFallback = bootstrapRoot === resolveAcpBootstrapRoot(),
): string {
  const normalizedProjectRoot = resolve(projectRoot);
  const projectSlug = sanitizeSegment(basename(normalizedProjectRoot), 'project');
  const providerSlug = sanitizeSegment(providerProfile, 'profile');
  const digest = createHash('sha1').update(`${normalizedProjectRoot}::${providerProfile}`).digest('hex').slice(0, 12);
  const leaf = `${projectSlug}-${providerSlug}-${digest}`;
  let root = bootstrapRoot;
  let dir = join(root, leaf);
  if (process.platform === 'win32') {
    // Creates with a private DACL atomically; existing directories are only
    // inspected, never repaired. Windows chmod cannot enforce this boundary.
    try {
      windowsEnsure(root, dir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallbackDir = windowsFallbackRoot ? join(windowsFallbackRoot, leaf) : undefined;
      // Only an unsafe ancestor chain justifies relocating the root. A reparse
      // point at the cwd itself must still fail closed.
      if (!allowWindowsFallback || !fallbackDir || !/permits unsafe directory replacement/.test(message)) throw error;
      if (resolve(fallbackDir) === resolve(dir)) throw error;
      // A sibling principal (sandbox group or another local user) holds Modify
      // or Delete on the temp-profile ancestors, so it could replace the private
      // bootstrap directory. ProgramData's default ancestor chain stays trusted
      // and the fallback root receives the same protected owner-only DACL.
      console.warn(`[acp] Windows ACP bootstrap root rejected (${message}); using ${windowsFallbackRoot}`);
      // The private root must be created by the ACL helper, so only the
      // non-sensitive container above it is created here.
      mkdirSync(dirname(windowsFallbackRoot as string), { recursive: true });
      windowsEnsure(windowsFallbackRoot as string, fallbackDir);
      root = windowsFallbackRoot as string;
      dir = fallbackDir;
    }
  } else {
    mkdirSync(root, { recursive: true, mode: OWNER_ONLY_MODE });
    assertRealDirectory(root, 'ACP bootstrap root');
    enforceOwnerOnlyPermissions(root);
    try {
      mkdirSync(dir, { recursive: false, mode: OWNER_ONLY_MODE });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    assertRealDirectory(dir, 'ACP bootstrap cwd');
    enforceOwnerOnlyPermissions(dir);
  }
  assertRealDirectory(root, 'ACP bootstrap root');
  assertRealDirectory(dir, 'ACP bootstrap cwd');
  const realBootstrapRoot = realpathSync(root);
  const realDir = realpathSync(dir);
  if (!isPathWithinRoot(realBootstrapRoot, realDir, { relative, isAbsolute })) {
    throw new Error(`ACP bootstrap cwd escaped bootstrap root: ${realDir}`);
  }
  return dir;
}

/**
 * Preserve repo-relative command resolution after switching ACP spawn cwd to the
 * isolated bootstrap directory.
 */
export function resolveAcpBootstrapCommand(projectRoot: string, command: string): string {
  const normalizedProjectRoot = resolve(projectRoot);
  const trimmed = command.trim();
  if (!trimmed || isAbsolute(trimmed) || (!isExplicitRelativePath(trimmed) && !/[\\/]/.test(trimmed))) {
    return command;
  }
  const candidate = resolve(normalizedProjectRoot, trimmed);
  return existsSync(candidate) ? candidate : command;
}

function resolveAcpBootstrapArg(projectRoot: string, arg: string): string {
  const normalizedProjectRoot = resolve(projectRoot);
  const trimmed = arg.trim();
  if (!trimmed) return arg;
  if (trimmed.startsWith('-')) {
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) return arg;
    const flag = trimmed.slice(0, eqIndex + 1);
    const value = trimmed.slice(eqIndex + 1);
    if (!value || isAbsolute(value) || !isPathLikeArgValue(value)) {
      return arg;
    }
    const candidate = resolve(normalizedProjectRoot, value);
    return existsSync(candidate) ? `${flag}${candidate}` : arg;
  }
  if (isAbsolute(trimmed) || !isPathLikeArgValue(trimmed)) {
    return arg;
  }
  const candidate = resolve(normalizedProjectRoot, trimmed);
  return existsSync(candidate) ? candidate : arg;
}

const ARG_TEMPLATE_RE = /\$\{(base_model|model)\}/g;

function expandAcpBootstrapArgTemplates(arg: string, vars?: Record<string, string | undefined>): string {
  if (!vars) return arg;
  return arg.replace(ARG_TEMPLATE_RE, (_, name: string) => vars[name] ?? '');
}

export function resolveAcpBootstrapArgs(
  projectRoot: string,
  args: readonly string[],
  templateVars?: Record<string, string | undefined>,
): string[] {
  return args.map((arg) => resolveAcpBootstrapArg(projectRoot, expandAcpBootstrapArgTemplates(arg, templateVars)));
}
