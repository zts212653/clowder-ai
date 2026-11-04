import type { DossierProfile } from './dossier/parse-dossier-profiles.js';
import type { CatConfig } from './types/cat.js';

/** One source decision for self identity, teammate routing and compiler preview. */
export function resolveMemberIdentity(config: CatConfig, dossier?: DossierProfile) {
  const sources = config.identitySources;
  const configured = !sources || Object.values(sources).some((source) => source !== 'template');
  const suppression = configured
    ? [
        ...(dossier?.l0SelfDescription !== undefined ? ['l0SelfDescription'] : []),
        ...(dossier?.l0RosterSummary !== undefined ? ['l0RosterSummary'] : []),
      ]
    : [];
  const cautionConfigured = !sources || sources.caution !== 'template';
  if (cautionConfigured && dossier?.l0RoutingNote !== undefined) suppression.push('l0RoutingNote');
  return {
    roleDescription: config.roleDescription,
    personality: config.personality,
    selfDescription: configured ? undefined : dossier?.l0SelfDescription,
    rosterDescription: configured
      ? (config.teamStrengths ?? config.roleDescription)
      : (dossier?.l0RosterSummary ?? config.teamStrengths ?? config.roleDescription),
    routingNote: cautionConfigured ? config.caution : (dossier?.l0RoutingNote ?? config.caution),
    sources: {
      fields: sources ?? 'configured',
      selfDescription: !configured && dossier?.l0SelfDescription !== undefined ? 'dossier' : 'configuration',
      rosterDescription: !configured && dossier?.l0RosterSummary !== undefined ? 'dossier' : 'configuration',
    },
    suppressedDossierFields: suppression,
  };
}
