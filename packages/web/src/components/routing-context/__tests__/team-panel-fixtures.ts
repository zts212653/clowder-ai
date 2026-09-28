import type { RoutingContextReadModelV1 } from '@cat-cafe/shared';

/**
 * Shared Team panel fixtures. The catalog entries mirror the real GET /api/cats
 * projection: `displayName` carries the breed + variant name and the human nickname
 * lives in its own field.
 */
export const TEAM_CATALOG: Record<string, Record<string, unknown>> = {
  'codex-sol': {
    id: 'codex-sol',
    displayName: '缅因猫 Sol',
    nickname: '小太阳·砚砚',
    breedDisplayName: '缅因猫 Sol',
    variantLabel: 'GPT-5.6 Sol',
    defaultModel: 'gpt-5.6-sol',
    avatar: '/avatars/codex-sol.png',
    color: { primary: '#a86', secondary: '#dcb' },
  },
  'codex-terra': {
    id: 'codex-terra',
    displayName: '缅因猫 Terra',
    nickname: '小团团·砚砚',
    breedDisplayName: '缅因猫 Terra',
    variantLabel: 'GPT-5.6 Terra',
    defaultModel: 'gpt-5.6-terra',
    avatar: '/avatars/codex-terra.png',
    color: { primary: '#a86', secondary: '#dcb' },
  },
  opus5: {
    id: 'opus5',
    displayName: '布偶猫 Opus 5',
    nickname: '宪宪',
    breedDisplayName: '布偶猫 Opus 5',
    defaultModel: 'claude-opus-5',
    avatar: '/avatars/opus5.png',
    color: { primary: '#68a', secondary: '#bcd' },
  },
};

export const model = {
  v: 1,
  ownerId: 'owner-1',
  observedAt: 1_800_000_000_000,
  catalogRevision: 'catalog:1',
  resolution: {
    state: 'fresh',
    inputRevisionRef: 'routing:1',
    sourceRefs: { signalEventIds: ['signal-1'], preferenceRevisionIds: [], dossierRevisions: ['dossier:1'] },
    snapshot: {
      v: 1,
      ownerId: 'owner-1',
      observedAt: 1_800_000_000_000,
      catalogRevision: 'catalog:1',
      candidates: [
        {
          binding: { v: 1, catId: 'codex-sol', providerId: 'openai', provenQuotaPools: [] },
          profile: {
            state: 'applied',
            revision: {
              v: 1,
              catId: 'codex-sol',
              modelId: 'gpt-5.6-sol',
              dossierRevision: 'dossier:codex-sol:7',
              updatedAt: 1_799_999_000_000,
              relevantSignals: [{ kind: 'strength', summary: '复杂系统攻坚', evidenceRefs: ['evidence:strength'] }],
              pendingProposalCount: 1,
            },
          },
          availability: 'scarce',
          freshness: 'fresh',
          reasons: [{ code: 'manual-limit', summary: '本周额度需要节制', sourceRefs: ['signal-1'] }],
          matchedPreferences: [],
          effect: 'advisory',
        },
      ],
    },
  },
  signalEvents: [],
  preferenceRevisions: [],
} satisfies RoutingContextReadModelV1;

export const rosterModel = (() => {
  const next = structuredClone(model) as RoutingContextReadModelV1;
  if (next.resolution.state !== 'fresh') throw new Error('expected fresh fixture');
  next.resolution.snapshot.candidates.push(
    {
      binding: { v: 1, catId: 'codex-terra', providerId: 'openai', provenQuotaPools: [] },
      profile: {
        state: 'applied',
        revision: {
          v: 1,
          catId: 'codex-terra',
          modelId: 'gpt-5.6-terra',
          dossierRevision: 'dossier:codex-terra:2',
          updatedAt: 1_799_998_000_000,
          relevantSignals: [
            { kind: 'strength', summary: '跨仓状态机', evidenceRefs: ['evidence:terra-fit'] },
            { kind: 'anti_signal', summary: '只有几行机械修改时不值得请他', evidenceRefs: ['evidence:terra-watch'] },
          ],
          pendingProposalCount: 0,
        },
      },
      availability: 'available',
      freshness: 'fresh',
      reasons: [],
      matchedPreferences: [],
      effect: 'eligible',
    },
    {
      binding: { v: 1, catId: 'opus5', providerId: 'anthropic', provenQuotaPools: [] },
      profile: { state: 'absent' },
      availability: 'unknown',
      freshness: 'unknown',
      reasons: [{ code: 'signal-missing', summary: '还没有读到当前状态', sourceRefs: ['signal:none'] }],
      matchedPreferences: [],
      effect: 'advisory',
    },
  );
  return next;
})();

export function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
