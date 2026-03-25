import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { isUnderAllowedRoot } from '../utils/project-path.js';

const CAT_CAFE_DIR = '.cat-cafe';
const META_FILENAME = 'provider-profiles.json';
const KNOWN_ROOTS_FILENAME = 'known-project-roots.json';

export function isAllowedProviderProfilesRoot(absPath: string): boolean {
  return isUnderAllowedRoot(absPath);
}

/**
 * Register a project root in the global known-roots registry.
 * Called on every provider store access so delete can check all projects.
 */
export function registerProjectRoot(projectRoot: string): void {
  const globalRoot = resolveGlobalRoot();
  const dir = resolve(globalRoot, CAT_CAFE_DIR);
  const filePath = resolve(dir, KNOWN_ROOTS_FILENAME);
  let roots: string[] = [];
  if (existsSync(filePath)) {
    try {
      roots = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      /* corrupt file — reset */
    }
  }
  const absRoot = resolve(projectRoot);
  if (!Array.isArray(roots)) roots = [];
  if (!roots.includes(absRoot)) {
    roots.push(absRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(roots, null, 2)}\n`);
  }
}

/**
 * Returns project roots whose cat-catalogs may reference a provider profile.
 * Scans the known-roots registry to cover all projects that have ever used
 * global provider profiles. Filters to roots that still exist on disk.
 */
export async function listProviderProfilesProjectRoots(projectRoot: string): Promise<string[]> {
  const globalRoot = resolveGlobalRoot();
  const filePath = resolve(globalRoot, CAT_CAFE_DIR, KNOWN_ROOTS_FILENAME);
  const roots = new Set<string>([resolve(projectRoot)]);
  if (existsSync(filePath)) {
    try {
      const stored = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (Array.isArray(stored)) {
        for (const r of stored) {
          if (typeof r === 'string' && existsSync(r)) {
            roots.add(resolve(r));
          }
        }
      }
    } catch {
      /* ignore corrupt registry */
    }
  }
  return [...roots];
}

function resolveGlobalRoot(): string {
  const envRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  if (envRoot) {
    const resolved = resolve(envRoot);
    try { return realpathSync(resolved); } catch { return resolved; }
  }
  return homedir();
}

/**
 * Resolve the storage root for provider-profiles.
 * Default: user home directory (global).
 * Override: CAT_CAFE_GLOBAL_CONFIG_ROOT env var.
 */
export async function resolveProviderProfilesRoot(_projectRoot: string): Promise<string> {
  return resolveGlobalRoot();
}

export function resolveProviderProfilesRootSync(_projectRoot: string): string {
  return resolveGlobalRoot();
}

/**
 * Check whether a project-local provider-profiles.json exists that should be
 * migrated to the global location. Returns the project-local storage root
 * if migration is needed, or null if not.
 *
 * Triggers migration when:
 * - Local meta exists AND global meta does not (first project)
 * - Local meta exists AND global meta exists (merge scenario — second+ project)
 */
export function detectProjectLocalProfiles(projectRoot: string): string | null {
  let absProject = resolve(projectRoot);
  try { absProject = realpathSync(absProject); } catch { /* keep resolved */ }
  const globalRoot = resolveGlobalRoot();
  // Don't migrate when project root IS the global root
  if (absProject === globalRoot) return null;
  const localMeta = resolve(absProject, CAT_CAFE_DIR, META_FILENAME);
  if (!existsSync(localMeta)) return null;
  return absProject;
}
