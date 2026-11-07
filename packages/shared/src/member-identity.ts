import type { DossierProfile } from './dossier/parse-dossier-profiles.js';
import type { CatConfig } from './types/cat.js';

function suppressedDossierField(configured: boolean, field: string, value: string | undefined): string[] {
  return configured && value !== undefined ? [field] : [];
}

/** One source decision for self identity, teammate routing and compiler preview. */
export function resolveMemberIdentity(config: CatConfig, dossier?: DossierProfile) {
  const sources = config.identitySources;
  const selfConfigured = !sources || Object.values(sources).some((source) => source !== 'template');
  const rosterConfigured = !sources || sources.teamStrengths !== 'template';
  const cautionConfigured = !sources || sources.caution !== 'template';
  const suppression = [
    ...suppressedDossierField(selfConfigured, 'l0SelfDescription', dossier?.l0SelfDescription),
    ...suppressedDossierField(rosterConfigured, 'l0RosterSummary', dossier?.l0RosterSummary),
    ...suppressedDossierField(cautionConfigured, 'l0RoutingNote', dossier?.l0RoutingNote),
  ];
  const rosterFallback = config.teamStrengths?.trim() ? config.teamStrengths : config.roleDescription;
  return {
    roleDescription: config.roleDescription,
    personality: config.personality,
    selfDescription: selfConfigured ? undefined : dossier?.l0SelfDescription,
    rosterDescription: rosterConfigured ? rosterFallback : (dossier?.l0RosterSummary ?? rosterFallback),
    routingNote: cautionConfigured ? config.caution : (dossier?.l0RoutingNote ?? config.caution),
    sources: {
      fields: sources ?? 'configured',
      selfDescription: !selfConfigured && dossier?.l0SelfDescription !== undefined ? 'dossier' : 'configuration',
      rosterDescription: !rosterConfigured && dossier?.l0RosterSummary !== undefined ? 'dossier' : 'configuration',
    },
    suppressedDossierFields: suppression,
  };
}
