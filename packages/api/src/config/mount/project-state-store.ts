/**
 * Project State Store — F228 Phase 4
 *
 * Per-project tracking state stored in `.cat-cafe/project-state.json`.
 * Currently holds the user's "ignore this drift" hash so the Drift Resolution
 * Modal doesn't re-prompt until source/policy actually change.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

const CONFIG_SUBDIR = '.cat-cafe';
const PROJECT_STATE_FILENAME = 'project-state.json';

export interface ProjectState {
  /** Schema version. */
  version: 1;
  /** Hash of (source manifest ∪ policy snapshot) when the user clicked "ignore". */
  ignoredDriftHash?: string;
  /** ISO timestamp of the ignore action. */
  ignoredAt?: string;
}

const EMPTY_STATE: ProjectState = { version: 1 };

function safePath(projectRoot: string, ...segments: string[]): string {
  const root = resolve(projectRoot);
  const normalized = resolve(root, ...segments);
  const rel = relative(root, normalized);
  if (rel.startsWith(`..${sep}`) || rel === '..') {
    throw new Error(`Path escapes project root: ${normalized}`);
  }
  return normalized;
}

/** Read project state — empty state ({ version: 1 }) when missing/invalid. */
export async function readProjectState(projectRoot: string): Promise<ProjectState> {
  const filePath = safePath(projectRoot, CONFIG_SUBDIR, PROJECT_STATE_FILENAME);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return { ...EMPTY_STATE };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_STATE };
  }
  if (!parsed || typeof parsed !== 'object') return { ...EMPTY_STATE };
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) return { ...EMPTY_STATE };
  const state: ProjectState = { version: 1 };
  if (typeof obj.ignoredDriftHash === 'string' && obj.ignoredDriftHash.length > 0) {
    state.ignoredDriftHash = obj.ignoredDriftHash;
  }
  if (typeof obj.ignoredAt === 'string' && obj.ignoredAt.length > 0) {
    state.ignoredAt = obj.ignoredAt;
  }
  return state;
}

/** Persist project state, creating .cat-cafe/ if needed. */
export async function writeProjectState(projectRoot: string, state: ProjectState): Promise<void> {
  const dir = safePath(projectRoot, CONFIG_SUBDIR);
  await mkdir(dir, { recursive: true });
  const filePath = safePath(projectRoot, CONFIG_SUBDIR, PROJECT_STATE_FILENAME);
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

/** Convenience: record an "ignore current drift" decision for this project. */
export async function markDriftIgnored(projectRoot: string, driftHash: string): Promise<void> {
  const current = await readProjectState(projectRoot);
  await writeProjectState(projectRoot, {
    ...current,
    ignoredDriftHash: driftHash,
    ignoredAt: new Date().toISOString(),
  });
}

/** Convenience: clear the ignored-drift state (e.g. after successful sync). */
export async function clearDriftIgnored(projectRoot: string): Promise<void> {
  const current = await readProjectState(projectRoot);
  const { ignoredDriftHash: _h, ignoredAt: _t, version: _v, ...rest } = current;
  await writeProjectState(projectRoot, { version: 1, ...rest });
}
