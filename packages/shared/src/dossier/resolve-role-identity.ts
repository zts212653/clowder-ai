/**
 * One source decision for a member's prompt identity, shared by the L0 self
 * identity, the L0 teammate roster and the runtime SystemPromptBuilder roster.
 *
 * The effective (saved + breed/variant-resolved) member config is the identity
 * authority. A dossier only fills what the owner has not configured:
 *  - `role`: once the owner edits roleDescription/personality, the dossier's
 *    unstructured l0SelfDescription is suppressed as a whole (it cannot be split
 *    into the edited and unedited halves).
 *  - `roster`: once the owner edits teamStrengths/caution, dossier roster text
 *    (l0RosterSummary / l0RoutingNote) is suppressed.
 * Members without the marker keep the historic dossier-first projection, with
 * the source recorded. Pronouns stay a dossier-only supplementary fact.
 */
import type { CatConfig } from '../types/cat.js';
import type { DossierProfile } from './parse-dossier-profiles.js';

export type RoleIdentityField = 'role' | 'roster';
export type RoleIdentitySource = 'config' | 'dossier';

export interface SuppressedDossierSegment {
  readonly field: 'l0SelfDescription' | 'l0RosterSummary' | 'l0RoutingNote';
  readonly reason: 'configured_identity';
}

export interface ResolvedRoleIdentity {
  /** Dossier self description when it is the self-identity source. */
  readonly selfDescription?: string;
  readonly roleDescription: string;
  readonly personality: string;
  readonly selfSource: RoleIdentitySource;
  /** Teammate roster "strengths" cell text (before compaction). */
  readonly rosterSummary: string;
  readonly rosterSummarySource: RoleIdentitySource;
  /** Teammate routing note; undefined = none. */
  readonly routingNote?: string;
  readonly routingNoteSource: RoleIdentitySource;
  readonly pronouns?: string;
  readonly suppressed: readonly SuppressedDossierSegment[];
}

type IdentityConfig = Pick<
  CatConfig,
  'roleDescription' | 'personality' | 'teamStrengths' | 'caution' | 'configuredIdentity'
>;

export function resolveRoleIdentity(config: IdentityConfig, dossier: DossierProfile | undefined): ResolvedRoleIdentity {
  const configured = new Set(config.configuredIdentity ?? []);
  const suppressed: SuppressedDossierSegment[] = [];
  const dossierText = (field: SuppressedDossierSegment['field'], owner: RoleIdentityField) => {
    const value = dossier?.[field]?.trim() || undefined;
    if (value && configured.has(owner)) {
      suppressed.push({ field, reason: 'configured_identity' });
      return undefined;
    }
    return value;
  };

  const selfDescription = dossierText('l0SelfDescription', 'role');
  const dossierRoster = dossierText('l0RosterSummary', 'roster');
  const dossierRouting = dossierText('l0RoutingNote', 'roster');
  const configRoutingNote = config.caution ?? undefined;
  const pronouns = dossier?.identity?.l0PronounReminder ? dossier.identity.pronouns : undefined;

  return {
    ...(selfDescription ? { selfDescription } : {}),
    roleDescription: config.roleDescription,
    personality: config.personality,
    selfSource: selfDescription ? 'dossier' : 'config',
    rosterSummary: dossierRoster ?? config.teamStrengths ?? config.roleDescription,
    rosterSummarySource: dossierRoster ? 'dossier' : 'config',
    ...((dossierRouting ?? configRoutingNote) ? { routingNote: dossierRouting ?? configRoutingNote } : {}),
    routingNoteSource: dossierRouting ? 'dossier' : 'config',
    ...(pronouns ? { pronouns } : {}),
    suppressed,
  };
}
