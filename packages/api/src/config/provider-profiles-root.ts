import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { isUnderAllowedRoot } from '../utils/project-path.js';

const CAT_CAFE_DIR = '.cat-cafe';
const META_FILENAME = 'provider-profiles.json';

export function isAllowedProviderProfilesRoot(absPath: string): boolean {
  return isUnderAllowedRoot(absPath);
}

/**
 * Returns project roots whose cat-catalogs may reference a provider profile.
 * Provider profiles are now global, but cat-catalogs remain per-project,
 * so this still returns the project root for catalog scanning.
 */
export async function listProviderProfilesProjectRoots(projectRoot: string): Promise<string[]> {
  return [resolve(projectRoot)];
}

function resolveGlobalRoot(): string {
  const envRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  if (envRoot) return resolve(envRoot);
  return homedir();
}

/**
 * Resolve the storage root for provider-profiles.
 * Default: user home directory (global).
 * Override: CAT_CAFE_GLOBAL_CONFIG_ROOT env var.
 *
 * Falls back to projectRoot when the global root already has no profiles
 * but the project root does (first-run migration scenario handled by caller).
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
 */
export function detectProjectLocalProfiles(projectRoot: string): string | null {
  const localMeta = resolve(projectRoot, CAT_CAFE_DIR, META_FILENAME);
  const globalMeta = resolve(resolveGlobalRoot(), CAT_CAFE_DIR, META_FILENAME);
  if (existsSync(localMeta) && !existsSync(globalMeta)) {
    return resolve(projectRoot);
  }
  return null;
}
