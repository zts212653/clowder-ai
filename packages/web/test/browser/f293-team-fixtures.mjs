/** A real 1x1 PNG so an avatar assertion can require an actually decoded image. */
export const TEAM_AVATAR =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * The real GET /api/cats projection: `displayName` carries the breed + variant name and
 * the human nickname lives in `nickname`. An earlier fixture folded the nickname into
 * `displayName`, which made an identity defect invisible to a green gate.
 */
export const TEAM_CATS = [
  {
    id: 'codex-terra',
    name: '缅因猫 Terra',
    displayName: '缅因猫 Terra',
    nickname: '小团团·砚砚',
    breedDisplayName: '缅因猫 Terra',
    variantLabel: 'GPT-5.6 Terra',
    color: { primary: 'var(--color-codex-primary)', secondary: 'var(--color-codex-bg)' },
    mentionPatterns: ['@codex-terra'],
    clientId: 'openai',
    defaultModel: 'gpt-5.6-terra',
    avatar: TEAM_AVATAR,
    roleDescription: '',
    personality: '',
    roster: { available: true },
  },
  {
    id: 'codex-sol',
    name: '缅因猫 Sol',
    displayName: '缅因猫 Sol',
    nickname: '小太阳·砚砚',
    breedDisplayName: '缅因猫 Sol',
    variantLabel: 'GPT-5.6 Sol',
    color: { primary: 'var(--color-codex-primary)', secondary: 'var(--color-codex-bg)' },
    mentionPatterns: ['@codex-sol'],
    clientId: 'openai',
    defaultModel: 'gpt-5.6-sol',
    avatar: TEAM_AVATAR,
    roleDescription: '',
    personality: '',
    roster: { available: true },
  },
  {
    id: 'opus5',
    name: '布偶猫 Opus 5',
    displayName: '布偶猫 Opus 5',
    nickname: '宪宪',
    breedDisplayName: '布偶猫 Opus 5',
    color: { primary: 'var(--color-claude-primary)', secondary: 'var(--color-claude-bg)' },
    mentionPatterns: ['@opus5'],
    clientId: 'anthropic',
    defaultModel: 'claude-opus-5',
    avatar: TEAM_AVATAR,
    roleDescription: '',
    personality: '',
    roster: { available: true },
  },
];

/**
 * Filler members exist for one reason: the roster must genuinely overflow the panel so a
 * scroll-continuity assertion cannot silently pass on a list that never scrolled.
 */
const FILLER_NAMES = [
  ['长毛猫 A', '阿毛'],
  ['长毛猫 B', '阿布'],
  ['长毛猫 C', '阿彩'],
  ['长毛猫 D', '阿丁'],
  ['长毛猫 E', '阿鹅'],
  ['长毛猫 F', '阿福'],
  ['长毛猫 G', '阿光'],
  ['长毛猫 H', '阿海'],
  ['长毛猫 I', '阿伊'],
  ['长毛猫 J', '阿吉'],
  ['长毛猫 K', '阿凯'],
  ['长毛猫 L', '阿蓝'],
  ['长毛猫 M', '阿蜜'],
  ['长毛猫 N', '阿宁'],
];

export const FILLER_CATS = FILLER_NAMES.map(([displayName, nickname], index) => ({
  id: `filler-${index + 1}`,
  name: displayName,
  displayName,
  nickname,
  breedDisplayName: displayName,
  color: { primary: 'var(--color-claude-primary)', secondary: 'var(--color-claude-bg)' },
  mentionPatterns: [`@filler-${index + 1}`],
  clientId: 'anthropic',
  defaultModel: `filler-model-${index + 1}`,
  avatar: TEAM_AVATAR,
  roleDescription: '',
  personality: '',
  roster: { available: true },
}));

TEAM_CATS.push(...FILLER_CATS);

export const TEAM_DOSSIER_REVISION = 'sha256:2fbb0d5c1f4a';

/** Mirrors the canonical routing read model shape served by GET /api/routing-context/snapshot. */
export function teamRoutingReadModel() {
  const observedAt = 1_800_000_000_000;
  return {
    v: 1,
    ownerId: 'f293-team-owner',
    observedAt,
    catalogRevision: 'catalog:f293-team',
    resolution: {
      state: 'fresh',
      inputRevisionRef: 'routing:f293-team:1',
      sourceRefs: {
        signalEventIds: ['signal:sol-quota'],
        preferenceRevisionIds: [],
        dossierRevisions: [TEAM_DOSSIER_REVISION],
      },
      snapshot: {
        v: 1,
        ownerId: 'f293-team-owner',
        observedAt,
        catalogRevision: 'catalog:f293-team',
        candidates: [
          {
            binding: { v: 1, catId: 'codex-terra', providerId: 'openai', provenQuotaPools: [] },
            profile: {
              state: 'applied',
              revision: {
                v: 1,
                catId: 'codex-terra',
                modelId: 'gpt-5.6-terra',
                dossierRevision: TEAM_DOSSIER_REVISION,
                updatedAt: 1_798_000_000_000,
                relevantSignals: [
                  {
                    kind: 'strength',
                    summary: '代码审查：复现问题并判断严重程度',
                    evidenceRefs: ['docs/team/cat-dossier.md#cat:codex-terra'],
                  },
                  {
                    kind: 'underused_strength',
                    summary: '跨仓库的状态管理、发布与同步',
                    evidenceRefs: ['docs/team/cat-dossier.md#cat:codex-terra'],
                  },
                  {
                    kind: 'anti_signal',
                    summary: '只有几行机械修改时，适合更轻量的选择',
                    evidenceRefs: ['docs/team/cat-dossier.md#cat:codex-terra'],
                  },
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
            binding: { v: 1, catId: 'codex-sol', providerId: 'openai', provenQuotaPools: [] },
            profile: {
              state: 'applied',
              revision: {
                v: 1,
                catId: 'codex-sol',
                modelId: 'gpt-5.6-sol',
                dossierRevision: 'sha256:9c31aa77b0de',
                updatedAt: 1_798_500_000_000,
                relevantSignals: [
                  {
                    kind: 'strength',
                    summary: '复杂架构与深层问题定位',
                    evidenceRefs: ['docs/team/cat-dossier.md#cat:codex-sol'],
                  },
                ],
                pendingProposalCount: 0,
              },
            },
            availability: 'scarce',
            freshness: 'fresh',
            reasons: [{ code: 'quota-scarce', summary: '本周额度需要节制', sourceRefs: ['signal:sol-quota'] }],
            matchedPreferences: [],
            effect: 'advisory',
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
          ...FILLER_CATS.map((cat) => ({
            binding: { v: 1, catId: cat.id, providerId: 'anthropic', provenQuotaPools: [] },
            profile: {
              state: 'applied',
              revision: {
                v: 1,
                catId: cat.id,
                modelId: cat.defaultModel,
                dossierRevision: `sha256:filler${cat.id}`,
                updatedAt: 1_798_000_000_000,
                relevantSignals: [
                  {
                    kind: 'strength',
                    summary: `${cat.nickname} 的既有长处摘要`,
                    evidenceRefs: [`docs/team/cat-dossier.md#cat:${cat.id}`],
                  },
                ],
                pendingProposalCount: 0,
              },
            },
            availability: 'available',
            freshness: 'fresh',
            reasons: [],
            matchedPreferences: [],
            effect: 'eligible',
          })),
        ],
      },
    },
    signalEvents: [],
    preferenceRevisions: [],
  };
}
