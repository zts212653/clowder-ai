import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, isAbsolute, join, type PlatformPath, relative, resolve } from 'node:path';

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

export function resolveAcpBootstrapRoot(): string {
  return join(tmpdir(), `cat-cafe-gemini-acp-${bootstrapOwnerSegment()}`);
}

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
export function resolveAcpBootstrapCwd(projectRoot: string, providerProfile: string): string {
  const normalizedProjectRoot = resolve(projectRoot);
  const projectSlug = sanitizeSegment(basename(normalizedProjectRoot), 'project');
  const providerSlug = sanitizeSegment(providerProfile, 'profile');
  const digest = createHash('sha1').update(`${normalizedProjectRoot}::${providerProfile}`).digest('hex').slice(0, 12);
  const bootstrapRoot = resolveAcpBootstrapRoot();
  mkdirSync(bootstrapRoot, { recursive: true, mode: OWNER_ONLY_MODE });
  assertRealDirectory(bootstrapRoot, 'ACP bootstrap root');
  enforceOwnerOnlyPermissions(bootstrapRoot);
  const realBootstrapRoot = realpathSync(bootstrapRoot);
  const dir = join(bootstrapRoot, `${projectSlug}-${providerSlug}-${digest}`);
  try {
    mkdirSync(dir, { recursive: false, mode: OWNER_ONLY_MODE });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
  }
  assertRealDirectory(dir, 'ACP bootstrap cwd');
  enforceOwnerOnlyPermissions(dir);
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

export function resolveAcpBootstrapArgs(projectRoot: string, args: readonly string[]): string[] {
  return args.map((arg) => resolveAcpBootstrapArg(projectRoot, arg));
}
