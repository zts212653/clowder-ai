/**
 * Persistent project-path boundary.
 *
 * The runtime checkout is a disposable binary worktree. User-owned project
 * writes must target the persistent workspace, while portable governance must
 * reject Cat Cafe itself (including descendants) because it is external-only.
 */

import { realpath, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import {
  isPathUnderRoots,
  type ProjectPathValidationFailureReason,
  pathsEqual,
  validateProjectPathDetailed,
} from './project-path.js';

export type PersistentProjectPathFailureReason =
  | ProjectPathValidationFailureReason
  | 'runtime_root_invalid'
  | 'runtime_workspace_missing'
  | 'runtime_target_unmappable';

export type PersistentProjectPathResult =
  | { ok: true; path: string; remappedFrom?: string }
  | { ok: false; reason: PersistentProjectPathFailureReason; message?: string };

export type ExternalProjectPathResult =
  | { ok: true; path: string }
  | {
      ok: false;
      reason: ProjectPathValidationFailureReason | 'cat_cafe_root_invalid' | 'cat_cafe_owned_path';
      message?: string;
    };

export interface PersistentProjectPathOptions {
  runtimeRoot?: string;
  workspaceRoot?: string;
  realpath?: typeof realpath;
  stat?: typeof stat;
}

type DirectoryPathResult =
  | { ok: true; path: string }
  | { ok: false; reason: Exclude<ProjectPathValidationFailureReason, 'denied_root'>; message?: string };

function isStoredProjectPathSentinel(rawPath: string): boolean {
  return rawPath === 'default' || rawPath.startsWith('games/');
}

async function resolveInternalDirectoryPath(
  rawPath: string,
  options: PersistentProjectPathOptions,
): Promise<DirectoryPathResult> {
  try {
    const path = await (options.realpath ?? realpath)(resolve(rawPath));
    const info = await (options.stat ?? stat)(path);
    if (!info.isDirectory()) return { ok: false, reason: 'not_directory' };
    return { ok: true, path };
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : undefined;
    const message = err instanceof Error ? err.message : undefined;
    return { ok: false, reason: ['ENOENT', 'ENOTDIR'].includes(code ?? '') ? 'not_found' : 'io_error', message };
  }
}

/** Map a runtime-root path to the same relative path in the workspace. */
export async function resolvePersistentProjectPathDetailed(
  rawPath: string,
  options: PersistentProjectPathOptions = {},
): Promise<PersistentProjectPathResult> {
  const runtimeRootRaw = options.runtimeRoot ?? process.env.CAT_CAFE_RUNTIME_ROOT;
  if (!runtimeRootRaw) return validateProjectPathDetailed(rawPath, options);

  // Runtime is an internal disposable checkout, not a user-selectable project.
  // Canonicalize both sides without applying PROJECT_ALLOWED_ROOTS so a runtime
  // input can be identified before project policy is applied to its destination.
  const target = await resolveInternalDirectoryPath(rawPath, options);
  if (!target.ok) return target;
  const runtimeRoot = await resolveInternalDirectoryPath(runtimeRootRaw, options);
  if (!runtimeRoot.ok) {
    return {
      ok: false,
      reason: 'runtime_root_invalid',
      message: `CAT_CAFE_RUNTIME_ROOT is invalid: ${runtimeRoot.message ?? runtimeRoot.reason}`,
    };
  }
  if (!isPathUnderRoots(target.path, [runtimeRoot.path])) {
    return validateProjectPathDetailed(target.path, options);
  }

  const workspaceRootRaw = options.workspaceRoot ?? process.env.CAT_CAFE_WORKSPACE_ROOT;
  if (!workspaceRootRaw) {
    return {
      ok: false,
      reason: 'runtime_workspace_missing',
      message: 'CAT_CAFE_WORKSPACE_ROOT is required for a project path inside CAT_CAFE_RUNTIME_ROOT',
    };
  }

  const workspaceRoot = await validateProjectPathDetailed(workspaceRootRaw, options);
  if (!workspaceRoot.ok) {
    return {
      ok: false,
      reason: 'runtime_workspace_missing',
      message: `CAT_CAFE_WORKSPACE_ROOT is invalid: ${workspaceRoot.message ?? workspaceRoot.reason}`,
    };
  }
  if (pathsEqual(runtimeRoot.path, workspaceRoot.path)) {
    return validateProjectPathDetailed(target.path, options);
  }

  return mapRuntimeTarget(target.path, runtimeRoot.path, workspaceRoot.path, options);
}

async function mapRuntimeTarget(
  targetPath: string,
  runtimeRoot: string,
  workspaceRoot: string,
  options: PersistentProjectPathOptions,
): Promise<PersistentProjectPathResult> {
  const mappedCandidate = resolve(workspaceRoot, relative(runtimeRoot, targetPath));
  const mapped = await validateProjectPathDetailed(mappedCandidate, options);
  if (!mapped.ok || !isPathUnderRoots(mapped.path, [workspaceRoot]) || isPathUnderRoots(mapped.path, [runtimeRoot])) {
    return {
      ok: false,
      reason: 'runtime_target_unmappable',
      message: mapped.ok
        ? 'Mapped workspace target escapes the persistent workspace or remains inside the runtime root'
        : `Matching workspace target is invalid: ${mapped.message ?? mapped.reason}`,
    };
  }

  return { ok: true, path: mapped.path, remappedFrom: targetPath };
}

export async function resolvePersistentProjectPath(rawPath: string): Promise<string | null> {
  const result = await resolvePersistentProjectPathDetailed(rawPath);
  return result.ok ? result.path : null;
}

/** Redirect runtime-owned roots while preserving the caller's path spelling otherwise. */
export async function redirectRuntimeProjectPath(
  rawPath: string,
  options: PersistentProjectPathOptions = {},
): Promise<string | null> {
  const result = await resolvePersistentProjectPathDetailed(rawPath, options);
  if (!result.ok) return null;
  return result.remappedFrom ? result.path : rawPath;
}

/**
 * Migrate an already-stored project path without re-validating unrelated legacy values.
 * Historical thread/proposal records may refer to an external directory that no longer
 * exists, so only a value demonstrably inside the runtime checkout is fail-closed here.
 */
export async function migrateStoredProjectPath(
  rawPath: string,
  options: PersistentProjectPathOptions = {},
): Promise<string | null> {
  if (isStoredProjectPathSentinel(rawPath)) return rawPath;

  const result = await resolvePersistentProjectPathDetailed(rawPath, options);
  if (result.ok) return result.remappedFrom ? result.path : rawPath;

  const runtimeRootRaw = options.runtimeRoot ?? process.env.CAT_CAFE_RUNTIME_ROOT;
  if (!runtimeRootRaw) return rawPath;

  const lexicalRuntimeRoot = resolve(runtimeRootRaw);
  const comparableRuntimeRoots = [lexicalRuntimeRoot];
  try {
    const canonicalRuntimeRoot = await (options.realpath ?? realpath)(lexicalRuntimeRoot);
    if (!comparableRuntimeRoots.includes(canonicalRuntimeRoot)) comparableRuntimeRoots.push(canonicalRuntimeRoot);
  } catch {
    // The runtime checkout may already be gone. Lexical comparison still
    // fail-closes ordinary descendants while preserving unrelated legacy paths.
  }

  return isPathUnderRoots(resolve(rawPath), comparableRuntimeRoots) ? null : rawPath;
}

/** Validate the external-only boundary used by portable governance. */
export async function validateExternalProjectPathDetailed(
  rawPath: string,
  catCafeRoot: string,
  options: PersistentProjectPathOptions = {},
): Promise<ExternalProjectPathResult> {
  const target = await validateProjectPathDetailed(rawPath, options);
  if (!target.ok) return target;

  const rootInputs = [
    catCafeRoot,
    options.runtimeRoot ?? process.env.CAT_CAFE_RUNTIME_ROOT,
    options.workspaceRoot ?? process.env.CAT_CAFE_WORKSPACE_ROOT,
  ].filter((root): root is string => Boolean(root));
  const ownedRoots: string[] = [];
  for (const rootInput of rootInputs) {
    const root = await resolveInternalDirectoryPath(rootInput, options);
    if (!root.ok) {
      return {
        ok: false,
        reason: 'cat_cafe_root_invalid',
        message: `Cat Cafe root is invalid: ${root.message ?? root.reason}`,
      };
    }
    if (!ownedRoots.some((existing) => pathsEqual(existing, root.path))) ownedRoots.push(root.path);
  }

  if (isPathUnderRoots(target.path, ownedRoots)) {
    return {
      ok: false,
      reason: 'cat_cafe_owned_path',
      message: 'Portable governance can only bootstrap an external project, not Cat Cafe or its descendants',
    };
  }
  return target;
}
