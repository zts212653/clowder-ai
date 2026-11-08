import type { DossierProfile } from './dossier/parse-dossier-profiles.js';
import type { CatConfig } from './types/cat.js';

function suppressedDossierField(configured: boolean, field: string, value: string | undefined): string[] {
  return configured && value !== undefined ? [field] : [];
}

type IdentityValues = Pick<CatConfig, 'roleDescription' | 'personality' | 'teamStrengths' | 'caution'> &
  Partial<Pick<CatConfig, 'name' | 'displayName' | 'nickname'>>;
type IdentityConfig = IdentityValues & Pick<CatConfig, 'identitySources'>;

/** Empty routing values opt back into the dossier; other fields retain explicit-clear semantics. */
export function hasAuthoredMemberIdentityValue(field: string, value: unknown): boolean {
  return field === 'caution' || field === 'teamStrengths'
    ? typeof value === 'string' && value.trim().length > 0
    : value !== undefined;
}

function applyIdentityDraft(base: IdentityConfig, draft?: Partial<IdentityValues>): IdentityConfig {
  const config = { ...base, ...draft };
  if (draft) {
    for (const field of [
      'name',
      'displayName',
      'nickname',
      'roleDescription',
      'personality',
      'teamStrengths',
      'caution',
    ] as const) {
      if (draft[field] === undefined || (draft[field] ?? '') === (base[field] ?? '')) continue;
      config.identitySources = {
        ...(config.identitySources ?? {
          roleDescription: 'variant',
          personality: 'variant',
          teamStrengths: 'variant',
          caution: 'variant',
        }),
        [field]: hasAuthoredMemberIdentityValue(field, draft[field]) ? 'variant' : 'template',
      };
    }
  }
  return config;
}

function rosterField(
  value: string | null | undefined,
  effectiveValue: string | null | undefined,
  fromDossier: boolean,
  template: boolean,
  replacedValue?: string,
  roleFallback = false,
) {
  const configuredValue = fromDossier || !value?.trim() ? '' : value;
  const source = fromDossier
    ? 'dossier'
    : roleFallback && !configuredValue
      ? 'role'
      : template
        ? 'template'
        : 'configuration';
  return { configuredValue, effectiveValue: effectiveValue ?? '', source, replacedValue };
}

function resolveIdentity(config: IdentityConfig, dossier?: DossierProfile) {
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
  const dossierRoster = dossier?.l0RosterSummary;
  const rosterFromDossier = !rosterConfigured && dossierRoster !== undefined;
  const routingFromDossier = !cautionConfigured && dossier?.l0RoutingNote !== undefined;
  const rosterDescription = rosterFromDossier ? dossierRoster : rosterFallback;
  const routingNote = routingFromDossier ? dossier.l0RoutingNote : config.caution;
  return {
    roleDescription: config.roleDescription,
    personality: config.personality,
    selfDescription: selfConfigured ? undefined : dossier?.l0SelfDescription,
    rosterDescription,
    routingNote,
    sources: {
      fields: sources ?? ('configured' as const),
      selfDescription: !selfConfigured && dossier?.l0SelfDescription !== undefined ? 'dossier' : 'configuration',
      rosterDescription: rosterFromDossier ? 'dossier' : 'configuration',
      routingNote: routingFromDossier ? 'dossier' : 'configuration',
    },
    rosterFields: {
      teamStrengths: rosterField(
        config.teamStrengths,
        rosterDescription,
        rosterFromDossier,
        sources?.teamStrengths === 'template',
        rosterConfigured ? dossierRoster : undefined,
        true,
      ),
      caution: rosterField(
        config.caution,
        routingNote,
        routingFromDossier,
        sources?.caution === 'template',
        cautionConfigured ? dossier?.l0RoutingNote : undefined,
      ),
    },
    suppressedDossierFields: suppression,
  };
}

/** One source decision for self identity, teammate routing, editor drafts and compiler preview. */
export function resolveMemberIdentity<T extends IdentityConfig>(
  base: T,
  dossier?: DossierProfile,
  draft?: Partial<IdentityValues>,
) {
  const saved = resolveIdentity(base, dossier);
  if (!draft) return saved;
  // Compare drafts with the editable baseline, not with a hidden template sentence.
  const editable = {
    ...base,
    teamStrengths: saved.rosterFields.teamStrengths.configuredValue,
    caution: saved.rosterFields.caution.configuredValue,
  };
  return resolveIdentity(applyIdentityDraft(editable, draft), dossier);
}
