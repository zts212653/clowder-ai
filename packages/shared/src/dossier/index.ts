export type { DossierSnapshot } from './load-dossier-profiles.js';
export {
  _resetDossierCache,
  getDossierL0Pronouns,
  getDossierL0RoutingNote,
  getDossierL0SelfDescription,
  getDossierProfile,
  getDossierRosterSummary,
  hasDossierEntry,
  isDossierAvailable,
  loadDossierProfiles,
  loadDossierSnapshot,
} from './load-dossier-profiles.js';
export type { DossierEngagementPolicy, DossierProfile } from './parse-dossier-profiles.js';
export { parseDossierProfiles } from './parse-dossier-profiles.js';
export type {
  ResolvedRoleIdentity,
  RoleIdentityField,
  RoleIdentitySource,
  SuppressedDossierSegment,
} from './resolve-role-identity.js';
export { resolveRoleIdentity } from './resolve-role-identity.js';
