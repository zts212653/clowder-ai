/**
 * ADR-025 Phase 1: Skills State — managed skill set + manifest hash
 *
 * Tracks which skills are managed by Clowder AI sync (vs externally installed).
 * Stored at `.cat-cafe/skills-state.json` in the project root.
 *
 * Written by:
 *   - `scripts/sync-skills.sh` (bash, for main repo sync)
 *   - `governance-bootstrap.ts` (TypeScript, for external project dispatch)
 *
 * Read by:
 *   - `/api/capabilities` route (source classification)
 *   - governance preflight (readiness check)
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

export interface SkillsState {
  /** Skill names managed by Clowder AI sync (source of truth for "managed vs external") */
  managedSkillNames: string[];
  /** Relative path from project root to skills source directory */
  sourceRoot: string;
  /** Hash of the source directory's skill listing (detects additions/removals) */
  sourceManifestHash: string;
  /** ISO 8601 timestamp of last successful sync */
  lastSyncedAt: string;
}

const STATE_DIR = '.cat-cafe';
const STATE_FILENAME = 'skills-state.json';

function safePath(root: string, ...segments: string[]): string {
  const rootResolved = resolve(root);
  const normalized = resolve(rootResolved, ...segments);
  const rel = relative(rootResolved, normalized);
  if (rel.startsWith(`..${sep}`) || rel === '..') {
    throw new Error(`Path escapes project root: ${normalized}`);
  }
  return normalized;
}

function isValidState(data: unknown): data is SkillsState {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return (
    Array.isArray(obj.managedSkillNames) &&
    typeof obj.sourceRoot === 'string' &&
    typeof obj.sourceManifestHash === 'string' &&
    typeof obj.lastSyncedAt === 'string'
  );
}

/**
 * Read skills-state.json from a project root.
 * Returns null if file doesn't exist or is invalid.
 */
export async function readSkillsState(projectRoot: string): Promise<SkillsState | null> {
  try {
    const filePath = safePath(projectRoot, STATE_DIR, STATE_FILENAME);
    const raw = await readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return isValidState(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Write skills-state.json to a project root.
 * Creates .cat-cafe/ directory if it doesn't exist.
 */
export async function writeSkillsState(projectRoot: string, state: SkillsState): Promise<void> {
  const dir = safePath(projectRoot, STATE_DIR);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, STATE_FILENAME);
  await writeFile(filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

/**
 * Compute a manifest hash from the source skills directory.
 * Hash = SHA-256 of sorted skill directory names (those containing SKILL.md).
 * Detects skill additions/removals. Content changes propagate via symlinks.
 */
export async function computeSourceManifestHash(sourceRoot: string): Promise<string> {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const skillNames: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const skillMd = join(sourceRoot, entry.name, 'SKILL.md');
      const s = await stat(skillMd);
      if (s.isFile()) skillNames.push(entry.name);
    } catch {
      // No SKILL.md — not a skill directory
    }
  }

  skillNames.sort();
  // Trailing newline matches bash `printf '%s\n' | sort | shasum`
  const digest = createHash('sha256')
    .update(skillNames.join('\n') + '\n')
    .digest('hex')
    .slice(0, 16);
  return `sha256:${digest}`;
}

/**
 * List skill directory names from source root (sorted).
 * Only includes directories containing SKILL.md.
 */
export async function listSourceSkillNames(sourceRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(sourceRoot, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const s = await stat(join(sourceRoot, entry.name, 'SKILL.md'));
        if (s.isFile()) names.push(entry.name);
      } catch {
        // No SKILL.md — not a skill directory
      }
    }
    return names.sort();
  } catch {
    return [];
  }
}

// --- ADR-025 Phase 2: Stale Detection ---

export interface SkillsStaleness {
  stale: boolean;
  currentHash: string;
  recordedHash: string | null;
  newSkills: string[];
  removedSkills: string[];
}

/**
 * Compare recorded manifest hash against current source directory.
 * Detects when skills have been added or removed since last sync.
 */
export async function checkStaleness(projectRoot: string, sourceRoot: string): Promise<SkillsStaleness> {
  const state = await readSkillsState(projectRoot);
  const currentHash = await computeSourceManifestHash(sourceRoot);
  const currentNames = await listSourceSkillNames(sourceRoot);
  const managedNames = state?.managedSkillNames ?? [];

  return {
    stale: state === null || state.sourceManifestHash !== currentHash,
    currentHash,
    recordedHash: state?.sourceManifestHash ?? null,
    newSkills: currentNames.filter((n) => !managedNames.includes(n)),
    removedSkills: managedNames.filter((n) => !currentNames.includes(n)),
  };
}

/**
 * Check if a skill name is in the managed set.
 * Returns false if state is null (backward compat: treat all as unmanaged).
 */
export function isManagedSkill(state: SkillsState | null, skillName: string): boolean {
  if (!state) return false;
  return state.managedSkillNames.includes(skillName);
}
