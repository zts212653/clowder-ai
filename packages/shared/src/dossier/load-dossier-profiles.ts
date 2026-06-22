/**
 * F208 KD-10/KD-12: Load and cache dossier profiles from cat-dossier.md.
 *
 * Provides `getDossierRosterSummary(catId)` for the fallback chain:
 *   dossier.l0RosterSummary ?? config.teamStrengths ?? config.roleDescription
 *
 * Consumers:
 * - compile-system-prompt-l0.mjs:buildRosterRow (line 243)
 * - SystemPromptBuilder.ts:buildTeammateRoster (line 453)
 *
 * Both must switch simultaneously (KD-12).
 *
 * Cache lifetime: process-scoped (no invalidation). Acceptable for Phase B because:
 * - compile-l0 is short-lived (script exits after compilation)
 * - API server restarts on deployment (new code → new process → fresh cache)
 * Phase C may add file-watcher or TTL invalidation if operator-driven hot-reload is needed.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DossierProfile } from './parse-dossier-profiles.js';
import { parseDossierProfiles } from './parse-dossier-profiles.js';

const DOSSIER_RELATIVE_PATH = 'docs/team/cat-dossier.md';

let _cachedProfiles: Map<string, DossierProfile> | null = null;
let _cachedProjectRoot: string | null = null;
/** Whether the dossier file was found and loaded (vs ENOENT / community scenario). */
let _dossierFileFound = false;

/**
 * Load dossier profiles from the project root.
 * Results are cached per projectRoot (reloaded if root changes).
 */
export function loadDossierProfiles(projectRoot: string): Map<string, DossierProfile> {
  if (_cachedProfiles && _cachedProjectRoot === projectRoot) {
    return _cachedProfiles;
  }

  const dossierPath = resolve(projectRoot, DOSSIER_RELATIVE_PATH);
  try {
    const content = readFileSync(dossierPath, 'utf-8');
    _cachedProfiles = parseDossierProfiles(content);
    _dossierFileFound = true;
  } catch (err: unknown) {
    const isNotFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
    _cachedProfiles = new Map();
    if (isNotFound) {
      // Community scenario — no dossier file. Silent fallback OK per KD-9.
      _dossierFileFound = false;
    } else {
      // KD-9: dossier exists but unreadable (permissions, corrupt, etc.) — drift signal.
      // Mark as found so consumer-side warnings still fire for built-in cats.
      _dossierFileFound = true;
      console.warn(`[F208 KD-9] Dossier exists but failed to load: ${dossierPath}`);
    }
  }
  _cachedProjectRoot = projectRoot;
  return _cachedProfiles;
}

/**
 * Whether the dossier file was found and successfully loaded for the given project root.
 * Used by consumers to distinguish "community has no dossier" (silent fallback OK)
 * from "built-in cat missing from existing dossier" (KD-9: must warn, not silent).
 */
export function isDossierAvailable(projectRoot: string): boolean {
  // Ensure cache is populated
  loadDossierProfiles(projectRoot);
  return _dossierFileFound;
}

/**
 * Get the l0RosterSummary for a cat from the dossier.
 * Returns undefined if the cat has no dossier entry or no l0RosterSummary field.
 *
 * Usage in fallback chain:
 *   const strengths = getDossierRosterSummary(catId, projectRoot) ?? config.teamStrengths ?? config.roleDescription;
 */
export function getDossierRosterSummary(catId: string, projectRoot: string): string | undefined {
  const profiles = loadDossierProfiles(projectRoot);
  return profiles.get(catId)?.l0RosterSummary;
}

/**
 * Whether a specific cat has a structured-profile entry in the dossier.
 * Used to scope KD-9 drift warnings: only warn for tracked cats (those with
 * dossier entries) whose l0RosterSummary is missing. Runtime/custom cats
 * with no dossier entry at all are expected to use config fallback silently.
 */
export function hasDossierEntry(catId: string, projectRoot: string): boolean {
  const profiles = loadDossierProfiles(projectRoot);
  return profiles.has(catId);
}

/** Reset the cache (for testing). */
export function _resetDossierCache(): void {
  _cachedProfiles = null;
  _cachedProjectRoot = null;
  _dossierFileFound = false;
}
