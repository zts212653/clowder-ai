/**
 * F136 Phase 4a — Cross-project account conflict detection (HC-5)
 *
 * Same accountRef across projects must have identical protocol/baseUrl/authType.
 * Used both at startup (scan) and write-path (pre-validate before persisting).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { AccountConfig } from '@cat-cafe/shared';
import { isSameProject } from '../utils/monorepo-root.js';

const CAT_CAFE_DIR = '.cat-cafe';

export interface AccountConflict {
  accountRef: string;
  details: string;
  projects: string[];
}

function resolveGlobalRoot(): string {
  const envRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  if (envRoot) return resolve(envRoot);
  return homedir();
}

function normalizeBaseUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : undefined;
}

function readKnownRoots(): string[] {
  const filePath = resolve(resolveGlobalRoot(), CAT_CAFE_DIR, 'known-project-roots.json');
  if (!existsSync(filePath)) return [];
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    return Array.isArray(data) ? data.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    // Corrupted known-project-roots.json silently disables HC-5 conflict detection.
    // Log so the user knows cross-project checks were skipped.
    console.warn(
      '[account-conflict-guard] known-project-roots.json is corrupted — HC-5 cross-project conflict detection skipped',
    );
    return [];
  }
}

function readProjectAccounts(projectRoot: string): Record<string, AccountConfig> {
  const catalogPath = resolve(projectRoot, CAT_CAFE_DIR, 'cat-catalog.json');
  if (!existsSync(catalogPath)) return {};
  try {
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    return catalog?.accounts ?? {};
  } catch {
    return {};
  }
}

function compareAccountConfigs(
  ref: string,
  a: AccountConfig,
  b: AccountConfig,
  projectA: string,
  projectB: string,
): AccountConflict | null {
  const diffs: string[] = [];
  if (a.protocol !== b.protocol) diffs.push(`protocol: ${a.protocol} vs ${b.protocol}`);
  if (a.authType !== b.authType) diffs.push(`authType: ${a.authType} vs ${b.authType}`);
  if (normalizeBaseUrl(a.baseUrl) !== normalizeBaseUrl(b.baseUrl)) {
    diffs.push(`baseUrl: ${a.baseUrl ?? '(none)'} vs ${b.baseUrl ?? '(none)'}`);
  }
  if (diffs.length === 0) return null;
  return {
    accountRef: ref,
    details: diffs.join('; '),
    projects: [projectA, projectB],
  };
}

/**
 * Scan all known project roots for accountRef conflicts.
 * Returns array of conflicts (empty = no issues).
 */
export function detectAccountConflicts(currentProjectRoot: string): AccountConflict[] {
  const knownRoots = readKnownRoots();
  const allRoots = new Set([resolve(currentProjectRoot), ...knownRoots.map((r) => resolve(r))]);

  // Group roots by git identity — worktrees of the same repo should not conflict with each other
  const deduped = deduplicateByGitIdentity(allRoots);

  const accountsByRef = new Map<string, { config: AccountConfig; project: string }>();
  const conflicts: AccountConflict[] = [];

  for (const root of deduped) {
    if (!existsSync(root)) continue;
    const accounts = readProjectAccounts(root);
    for (const [ref, config] of Object.entries(accounts)) {
      const existing = accountsByRef.get(ref);
      if (!existing) {
        accountsByRef.set(ref, { config, project: root });
        continue;
      }
      const conflict = compareAccountConfigs(ref, existing.config, config, existing.project, root);
      if (conflict) conflicts.push(conflict);
    }
  }

  return conflicts;
}

/** Pick one representative root per git project, skipping worktree duplicates. */
function deduplicateByGitIdentity(roots: Set<string>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let isDuplicate = false;
    for (const kept of result) {
      if (isSameProject(root, kept)) {
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) result.push(root);
  }
  return result;
}

/**
 * Write-path guard: validate a single account write against all known projects.
 * Throws on conflict (HC-5: don't persist bad config and wait for next startup to explode).
 */
export function validateAccountWrite(currentProjectRoot: string, ref: string, account: AccountConfig): void {
  const knownRoots = readKnownRoots();
  const resolved = resolve(currentProjectRoot);
  const allRoots = new Set(knownRoots.map((r) => resolve(r)));
  // Exclude current project and its worktrees — same git identity should not conflict
  for (const root of allRoots) {
    if (root === resolved || isSameProject(root, resolved)) {
      allRoots.delete(root);
    }
  }

  for (const root of allRoots) {
    if (!existsSync(root)) continue;
    const accounts = readProjectAccounts(root);
    const existing = accounts[ref];
    if (!existing) continue;
    const conflict = compareAccountConfigs(ref, existing, account, root, currentProjectRoot);
    if (conflict) {
      throw new Error(`Account conflict for "${ref}": ${conflict.details} ` + `(conflicts with project at ${root})`);
    }
  }
}
