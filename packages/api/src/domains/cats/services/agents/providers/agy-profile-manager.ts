import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AgyProfileConfig } from '@cat-cafe/shared';

export interface ResolveAgyProfileInput {
  readonly catId: string;
  readonly expectedModel: string;
  readonly workingDirectory: string;
  readonly config?: AgyProfileConfig;
}

export interface AgyProfile {
  readonly catId: string;
  readonly profileId: string;
  readonly homePath: string;
  /**
   * F210 cache-leak fix (砚砚 拍 cwd sandbox 方向)：agy spawn cwd 的 **per-profile base**（profile HOME
   * 下专用子目录）。实际 spawn cwd 由 `resolveAgySpawnCwd` 在此 base 下再按 workingDirectory 派生
   * per-worktree 子目录（`<cwdPath>/<workspaceKey>`，cloud P1：AGY 按 cwd scope conversation 命名空间，
   * 不能多 worktree 共用同一 cwd）。AGY 写 cwd-relative cache（`cache/projects.json`）到 spawn cwd——
   * cwd=repo root 时泄漏到 worktree（实证 2026-06-03）。cwd-relative cache 落 profile 而非 repo；
   * workspace 仍通过 `--add-dir workingDirectory` 显式授权。
   */
  readonly cwdPath: string;
  readonly settingsPath: string;
  readonly expectedModel: string;
  readonly trustedWorkspaces: readonly string[];
  readonly autoApprove: boolean;
}

export type AgyProfilePreflightFailureReason =
  | 'missing_binary'
  | 'unsafe_home'
  | 'settings_missing'
  | 'settings_unreadable'
  | 'model_mismatch'
  | 'untrusted_workspace';

export type AgyProfilePreflightResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: AgyProfilePreflightFailureReason;
      readonly message: string;
    };

export interface AgyProfilePreflightInput {
  readonly agyCommand: string | null | undefined;
  readonly workingDirectory: string;
}

function sanitizeProfileId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('AGY profile id must not be empty');
  const sanitized = trimmed.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  if (!sanitized || sanitized === '.' || sanitized === '..' || sanitized.includes('..')) {
    throw new Error(`Unsafe AGY profile id: ${value}`);
  }
  return sanitized;
}

function expandHomePath(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith(`~${sep}`)) return join(homedir(), path.slice(2));
  return path;
}

function resolveUnder(root: string, segment: string): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, segment);
  const rel = relative(resolvedRoot, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`AGY profile path escapes root: ${target}`);
  }
  return target;
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function uniqueResolvedPaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    String((err as { readonly code?: unknown }).code) === 'ENOENT'
  );
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

function isExistingSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

function canonicalProfileHomePath(homeRoot: string | null, homePath: string): string {
  const realHomePath = tryRealpath(homePath);
  if (realHomePath) return realHomePath;
  if (!homeRoot) return resolve(homePath);

  const resolvedRoot = resolve(homeRoot);
  const rel = relative(resolvedRoot, resolve(homePath));
  const realRoot = tryRealpath(resolvedRoot) ?? resolvedRoot;
  return resolve(realRoot, rel);
}

function realUserHomePath(): string {
  return tryRealpath(homedir()) ?? resolve(homedir());
}

export function resolveAgyProfile(input: ResolveAgyProfileInput): AgyProfile | null {
  const config = input.config;
  if (!config || config.enabled === false) return null;

  const profileId = sanitizeProfileId(config.profileId ?? input.catId);
  const homeRoot = resolve(
    expandHomePath(
      config.homeRoot ?? process.env.CAT_CAFE_AGY_PROFILE_ROOT ?? join(homedir(), '.cat-cafe', 'agy-profiles'),
    ),
  );
  const homePath = resolveUnder(homeRoot, profileId);
  const settingsDir = join(homePath, '.gemini', 'antigravity-cli');
  const settingsPath = join(settingsDir, 'settings.json');
  const cwdPath = join(homePath, 'cwd');
  const unsafeReason = getUnsafeAgyProfileTargetReason(homeRoot, homePath, settingsPath);
  if (unsafeReason) {
    throw new Error(unsafeReason);
  }
  const expectedModel = config.model?.trim();
  if (!expectedModel) throw new Error('Explicit AGY profile model label is required.');
  const trustedWorkspaces = uniqueResolvedPaths([...(config.trustedWorkspaces ?? []), input.workingDirectory]);

  mkdirSync(settingsDir, { recursive: true });
  mkdirSync(cwdPath, { recursive: true }); // F210 cache-leak: agy spawn cwd sandbox（cwd-relative cache 落此）
  const currentSettings = readSettings(settingsPath);
  const nextSettings = {
    ...currentSettings,
    model: expectedModel,
    trustedWorkspaces,
  };
  writeFileSync(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, 'utf8');

  return {
    catId: input.catId,
    profileId,
    homePath,
    cwdPath,
    settingsPath,
    expectedModel,
    trustedWorkspaces,
    autoApprove: config.autoApprove !== false,
  };
}

/**
 * F210 cache-leak fix (砚砚 拍 cwd sandbox 方向)：解析 agy spawn cwd（与 workingDirectory 解耦）。
 * AGY 写 cwd-relative cache（`cache/projects.json`）到 spawn cwd——必须是 sandbox 而非 repo root
 * （实证 2026-06-03）。
 *
 * **per-worktree 隔离（cloud P1）**：AGY 按 cwd scope conversation/project 命名空间（实证 H2a：
 * `cache/projects.json` 是 cwd-relative project registry）。若所有 worktree 共用 per-cat sandbox，
 * 多 repo 会串台 AGY history（resume/list 错乱）。所以 sandbox 必须**每个 workingDirectory 唯一**——
 * 用绝对 workingDirectory 的 sha256 hash 作 per-worktree 子目录键。
 *
 * 布局：`<base>/<workspaceKey>`，base =
 * - 有 agyProfile：`agyProfile.cwdPath`（profile HOME 下的 per-profile base）
 * - 无 agyProfile（production gemini/gemini25 当前路径）：`<root>/<sanitized-catId>`，
 *   root 默认 `~/.cat-cafe/agy-cwd`，可经 `CAT_CAFE_AGY_CWD_ROOT` override（mirror `CAT_CAFE_AGY_PROFILE_ROOT`）。
 *
 * symlink fail-closed（cloud P2）：base + sandbox 都拒绝已存在 symlink——mkdirSync(recursive) 会跟随
 * symlink 把 cwd-relative cache 写回 repo/真 HOME，绕过本修复。
 *
 * **为什么把 process cwd 挪到 sandbox 不破坏 AGY 工作区**（refute 静态 reviewer 把 process cwd 与
 * AGY active workspace 混为一谈，砚砚 probe 实测 2026-06-03）：AGY 的 active workspace 绑定到
 * `--add-dir workingDirectory`，**不是** process cwd。实测 `cd <sandbox> && agy --add-dir <work>`：
 * AGY tool `pwd` 回 `<work>`、能读 `<work>` 文件、`<work>/GEMINI.md` 指令照常加载；只有内部 cwd-relative
 * `cache/projects.json` 落 sandbox。所以三件事同时成立：active workspace=worktree（--add-dir 授权）、
 * cwd-relative cache 落 sandbox、conversation scope 由 per-worktree sandbox 隔离。GeminiAgentService 始终
 * 传 `--add-dir <absolute workingDirectory>`，不要删。
 */
export function resolveAgySpawnCwd(agyProfile: AgyProfile | null, catId: string, workingDirectory: string): string {
  const workspaceKey = createHash('sha256').update(resolve(workingDirectory)).digest('hex').slice(0, 16);
  const base = agyProfile
    ? agyProfile.cwdPath
    : resolveUnder(
        resolve(expandHomePath(process.env.CAT_CAFE_AGY_CWD_ROOT ?? join(homedir(), '.cat-cafe', 'agy-cwd'))),
        sanitizeProfileId(catId),
      );
  const sandbox = join(base, workspaceKey);
  for (const [label, path] of [
    ['cwd sandbox base', base],
    ['cwd sandbox', sandbox],
  ] as const) {
    if (isExistingSymlink(path)) {
      throw new Error(
        `AGY ${label} must not be a symlink (would redirect cwd-relative cache outside the sandbox): ${path}`,
      );
    }
  }
  mkdirSync(sandbox, { recursive: true });
  return sandbox;
}

function isRealUserAntigravitySettingsPath(path: string): boolean {
  const realAgyDir = join(realUserHomePath(), '.gemini', 'antigravity-cli');
  const resolvedPath = resolve(path);
  return resolvedPath === join(realAgyDir, 'settings.json') || resolvedPath.startsWith(`${realAgyDir}${sep}`);
}

function getUnsafeAgyProfileTargetReason(
  homeRoot: string | null,
  homePath: string,
  settingsPath: string,
): string | null {
  const geminiDir = join(homePath, '.gemini');
  const settingsDir = join(geminiDir, 'antigravity-cli');
  for (const [label, path] of [
    ['HOME', homePath],
    ['.gemini directory', geminiDir],
    ['settings directory', settingsDir],
    ['settings file', settingsPath],
    // F210 cache-leak hardening (cloud P2)：cwd sandbox 也必须拒绝 symlink——mkdirSync(recursive) 会
    // 跟随已存在的 symlink，spawn cwd 指向 link target（repo/真 HOME），cwd-relative cache 仍泄漏。
    ['cwd sandbox', join(homePath, 'cwd')],
  ] as const) {
    if (isExistingSymlink(path)) {
      return `AGY profile ${label} must not be a symlink: ${path}`;
    }
  }

  const canonicalHomePath = canonicalProfileHomePath(homeRoot, homePath);
  if (canonicalHomePath === realUserHomePath()) {
    return 'AGY profile sandbox points at the real user HOME; refusing to write shared state.';
  }

  const canonicalSettingsPath =
    tryRealpath(settingsPath) ?? join(canonicalHomePath, '.gemini', 'antigravity-cli', 'settings.json');
  if (isRealUserAntigravitySettingsPath(canonicalSettingsPath)) {
    return 'AGY profile sandbox points at the real user AGY settings path; refusing to write shared state.';
  }

  return null;
}

export function preflightAgyProfile(profile: AgyProfile, input: AgyProfilePreflightInput): AgyProfilePreflightResult {
  if (!input.agyCommand) {
    return {
      ok: false,
      reason: 'missing_binary',
      message: 'Antigravity CLI binary `agy` was not found. Install AGY before using an AGY profile.',
    };
  }
  const unsafeReason = getUnsafeAgyProfileTargetReason(null, profile.homePath, profile.settingsPath);
  if (unsafeReason) {
    return {
      ok: false,
      reason: 'unsafe_home',
      message: unsafeReason.replace('write shared state', 'run with shared state'),
    };
  }
  if (!existsSync(profile.settingsPath)) {
    return {
      ok: false,
      reason: 'settings_missing',
      message: `AGY profile settings file is missing: ${profile.settingsPath}`,
    };
  }

  let settings: Record<string, unknown>;
  try {
    settings = readSettings(profile.settingsPath);
  } catch (err) {
    return {
      ok: false,
      reason: 'settings_unreadable',
      message: `AGY profile settings file is unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const selectedModel = typeof settings.model === 'string' ? settings.model.trim() : '';
  if (selectedModel !== profile.expectedModel) {
    return {
      ok: false,
      reason: 'model_mismatch',
      message: `AGY profile selected model mismatch: expected "${profile.expectedModel}", found "${selectedModel || 'unset'}".`,
    };
  }

  const trustedWorkspaces = Array.isArray(settings.trustedWorkspaces)
    ? settings.trustedWorkspaces
        .filter((value): value is string => typeof value === 'string')
        .map((value) => resolve(value))
    : [];
  const workingDirectory = resolve(input.workingDirectory);
  if (!trustedWorkspaces.includes(workingDirectory)) {
    return {
      ok: false,
      reason: 'untrusted_workspace',
      message: `AGY profile trustedWorkspaces does not include assigned worktree "${workingDirectory}".`,
    };
  }

  return { ok: true };
}
