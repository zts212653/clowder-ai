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
 * Parsed profiles are reused while the dossier content is unchanged. The file is
 * reread on every access so an applied F208 revision becomes visible to routing
 * on its next resolution without requiring a process restart.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DossierProfile, DossierProfileDiagnostic } from './parse-dossier-profiles.js';
import { parseDossierProfilesWithDiagnostics } from './parse-dossier-profiles.js';

const DOSSIER_RELATIVE_PATH = 'docs/team/cat-dossier.md';

export type DossierSnapshot =
  | { state: 'absent'; profiles: Map<string, DossierProfile> }
  | { state: 'unreadable'; profiles: Map<string, DossierProfile>; errorCode: string }
  | { state: 'loaded'; profiles: Map<string, DossierProfile>; diagnostics: DossierProfileDiagnostic[] };

let cached: { projectRoot: string; content: string; snapshot: DossierSnapshot } | null = null;

/**
 * Load dossier profiles from the project root.
 * Parsed results are cached per projectRoot and exact source content.
 */
export function loadDossierProfiles(projectRoot: string): Map<string, DossierProfile> {
  return loadDossierSnapshot(projectRoot).profiles;
}

/** Read bytes and their diagnostics together; absence is only an ENOENT result. */
export function loadDossierSnapshot(projectRoot: string): DossierSnapshot {
  const dossierPath = resolve(projectRoot, DOSSIER_RELATIVE_PATH);
  try {
    const content = readFileSync(dossierPath, 'utf-8');
    if (cached?.projectRoot === projectRoot && cached.content === content) {
      return cached.snapshot;
    }
    const snapshot: DossierSnapshot = { state: 'loaded', ...parseDossierProfilesWithDiagnostics(content) };
    cached = { projectRoot, content, snapshot };
    if (snapshot.diagnostics.length > 0) {
      console.warn(`[F208 KD-9] Dossier block diagnostics: ${JSON.stringify(snapshot.diagnostics)} (${dossierPath})`);
    }
    return snapshot;
  } catch (err: unknown) {
    cached = null;
    const errorCode = (err as NodeJS.ErrnoException).code ?? 'unknown';
    if (errorCode === 'ENOENT') {
      // Community scenario — no dossier file. Silent fallback OK per KD-9.
      return { state: 'absent', profiles: new Map() };
    }
    console.warn(`[F208 KD-9] Dossier exists but failed to load (${errorCode}): ${dossierPath}`);
    return { state: 'unreadable', profiles: new Map(), errorCode };
  }
}

/**
 * Whether dossier absence was ruled out (read failures remain available for KD-9 diagnostics).
 * Used by consumers to distinguish "community has no dossier" (silent fallback OK)
 * from "built-in cat missing from existing dossier" (KD-9: must warn, not silent).
 */
export function isDossierAvailable(projectRoot: string): boolean {
  return loadDossierSnapshot(projectRoot).state !== 'absent';
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
 * Get the compact, route-critical note for the always-on L0 roster.
 * Capability profiles stay in l0RosterSummary / the dossier and load on demand.
 */
export function getDossierL0RoutingNote(catId: string, projectRoot: string): string | undefined {
  return loadDossierProfiles(projectRoot).get(catId)?.l0RoutingNote;
}

/**
 * Get the self-facing identity projection. Unlike oneLiner/routingSignals, this
 * field must be phrased as role/style plus an actionable correction, never as
 * a diagnosis delivered back to its subject.
 */
export function getDossierL0SelfDescription(catId: string, projectRoot: string): string | undefined {
  return loadDossierProfiles(projectRoot).get(catId)?.l0SelfDescription;
}

/**
 * Get pronouns only when the dossier explicitly opts this identity fact into
 * the scarce L0 roster. The marker is reserved for evidence-backed repeat
 * failures; ordinary dossier pronouns stay available without spending tokens.
 */
export function getDossierL0Pronouns(catId: string, projectRoot: string): string | undefined {
  const identity = loadDossierProfiles(projectRoot).get(catId)?.identity;
  return identity?.l0PronounReminder ? identity.pronouns : undefined;
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
  cached = null;
}
