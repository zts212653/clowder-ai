import type { RoutingContextSnapshotV1 } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import {
  buildTeamMemberIdentity,
  countTeamMembers,
  filterTeamMembers,
  readTeamAvailability,
  readTeamCapability,
  toTeamMemberRow,
} from '../team-member-projection';

type Candidate = RoutingContextSnapshotV1['candidates'][number];

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    binding: { v: 1, catId: 'codex-terra', providerId: 'openai', provenQuotaPools: [] },
    profile: {
      state: 'applied',
      revision: {
        v: 1,
        catId: 'codex-terra',
        modelId: 'gpt-5.6-terra',
        dossierRevision: 'sha256:abc',
        updatedAt: 1_799_000_000_000,
        relevantSignals: [
          { kind: 'strength', summary: '代码审查', evidenceRefs: ['evidence:a'] },
          { kind: 'underused_strength', summary: '跨仓状态机', evidenceRefs: ['evidence:b'] },
          { kind: 'summon_signal', summary: '需要可复现的问题定位时', evidenceRefs: ['evidence:c'] },
          { kind: 'anti_signal', summary: '只有几行机械修改时不值得请他', evidenceRefs: ['evidence:d'] },
          { kind: 'hard_limit', summary: '没有 IDE 浏览器桥', evidenceRefs: ['evidence:e'] },
        ],
        pendingProposalCount: 0,
      },
    },
    availability: 'available',
    freshness: 'fresh',
    reasons: [],
    matchedPreferences: [],
    effect: 'eligible',
    ...overrides,
  } as Candidate;
}

const absentProfileCandidate = candidate({
  binding: { v: 1, catId: 'opus5', providerId: 'anthropic', provenQuotaPools: [] },
  profile: { state: 'absent' },
  availability: 'unknown',
  effect: 'advisory',
  reasons: [{ code: 'signal-missing', summary: '还没有读到状态', sourceRefs: ['signal:none'] }],
});

describe('F293 team member projection', () => {
  it('splits an applied dossier revision into fit-for and watch-out readings by signal kind', () => {
    const reading = readTeamCapability(candidate());
    if (reading.state !== 'applied') throw new Error('expected an applied reading');
    expect(reading.fitSignals).toEqual(['代码审查', '跨仓状态机', '需要可复现的问题定位时']);
    expect(reading.watchOuts).toEqual(['只有几行机械修改时不值得请他', '没有 IDE 浏览器桥']);
    expect(reading.summary).toBe('代码审查 · 跨仓状态机 · 需要可复现的问题定位时');
  });

  it('keeps a missing profile honest instead of inventing capability from the model name', () => {
    const reading = readTeamCapability(absentProfileCandidate);
    expect(reading.state).toBe('absent');
    expect(reading.summary).toBe('能力资料待补充');
    expect(JSON.stringify(reading)).not.toContain('anthropic');
  });

  it('does not fabricate a summary when an applied revision carries no fit-for signal', () => {
    const reading = readTeamCapability(
      candidate({
        profile: {
          state: 'applied',
          revision: {
            v: 1,
            catId: 'codex-terra',
            modelId: 'gpt-5.6-terra',
            dossierRevision: 'sha256:abc',
            updatedAt: 1_799_000_000_000,
            relevantSignals: [{ kind: 'hard_limit', summary: '没有浏览器', evidenceRefs: ['evidence:e'] }],
            pendingProposalCount: 0,
          },
        },
      }),
    );
    if (reading.state !== 'applied') throw new Error('expected an applied reading');
    expect(reading.fitSignals).toEqual([]);
    expect(reading.summary).toBe('画像里还没有可读的长处摘要');
  });

  it('never reads availability as online, idle or already accountable', () => {
    expect(readTeamAvailability('available').label).toBe('可接任务');
    expect(readTeamAvailability('available').impact).toContain('不等于在线');
    expect(readTeamAvailability('unknown').tone).toBe('unknown');
    expect(readTeamAvailability('unknown').impact).toContain('也不代表不可用');
    expect(readTeamAvailability('unavailable').tone).toBe('blocked');
    expect(readTeamAvailability('scarce').tone).toBe('attention');
    expect(readTeamAvailability('degraded').tone).toBe('attention');
  });

  it('leads with the catalog nickname over the breed display name', () => {
    // Real GET /api/cats payload: displayName carries the breed+variant name and the
    // human nickname lives in its own field. Leading with displayName renders
    // "缅因猫 Terra" where the accepted layout asks for "小团团·砚砚".
    const terra = buildTeamMemberIdentity('codex-terra', {
      displayName: '缅因猫 Terra',
      nickname: '小团团·砚砚',
      breedDisplayName: '缅因猫 Terra',
      variantLabel: 'GPT-5.6 Terra',
      defaultModel: 'gpt-5.6-terra',
    });
    expect(terra.displayName).toBe('小团团·砚砚');
    // GPT-5.6 Terra and gpt-5.6-terra are the same fact written twice.
    expect(terra.secondaryLabel).toBe('缅因猫 Terra · gpt-5.6-terra');

    const noNickname = buildTeamMemberIdentity('opus5', {
      displayName: '布偶猫 Opus 5',
      breedDisplayName: '布偶猫 Opus 5',
      defaultModel: 'claude-opus-5',
    });
    expect(noNickname.displayName).toBe('布偶猫 Opus 5');
    // The primary line already said "布偶猫 Opus 5"; repeating it underneath is noise.
    expect(noNickname.secondaryLabel).toBe('claude-opus-5');

    const distinctVariant = buildTeamMemberIdentity('gemini', {
      displayName: '暹罗猫',
      nickname: '烁烁',
      breedDisplayName: '暹罗猫',
      variantLabel: 'Gemini 3.1 Pro (High)',
      defaultModel: 'gemini-3.1-pro',
    });
    expect(distinctVariant.secondaryLabel).toBe('暹罗猫 · Gemini 3.1 Pro (High) · gemini-3.1-pro');

    const unknown = buildTeamMemberIdentity('ghost-cat', undefined);
    expect(unknown.displayName).toBe('ghost-cat');
    expect(unknown.secondaryLabel).toBeNull();
  });

  it('keeps the trusted human attempt exception readable instead of a blanket rejection', () => {
    // RoutingPreflightService only rejects an unavailable target when the owner
    // cannot attempt it; with dispatch.ownerAttemptAllowed the owner still gets a
    // warned send (#4383). Copy that says "会被拒绝" contradicts live behaviour.
    const ownerMayTry = readTeamAvailability('unavailable', { ownerAttemptAllowed: true });
    expect(ownerMayTry.ownerAttemptAllowed).toBe(true);
    expect(ownerMayTry.impact).toContain('你仍然可以');
    expect(ownerMayTry.impact).not.toContain('会被拒绝');

    const hardStop = readTeamAvailability('unavailable', { ownerAttemptAllowed: false });
    expect(hardStop.ownerAttemptAllowed).toBe(false);
    expect(hardStop.impact).toContain('会被拒绝');

    // No dispatch context at all must not be read as permission.
    expect(readTeamAvailability('unavailable').ownerAttemptAllowed).toBe(false);
  });

  it('filters and counts members by attention and missing-profile without reordering the roster', () => {
    const rows = [
      toTeamMemberRow(candidate(), {
        displayName: '缅因猫 Terra',
        nickname: '小团团·砚砚',
        breedDisplayName: '缅因猫 Terra',
      }),
      toTeamMemberRow(
        candidate({
          binding: { v: 1, catId: 'codex-sol', providerId: 'openai', provenQuotaPools: [] },
          profile: {
            state: 'applied',
            revision: {
              v: 1,
              catId: 'codex-sol',
              modelId: 'gpt-5.6-sol',
              dossierRevision: 'sha256:def',
              updatedAt: 1_799_000_000_000,
              relevantSignals: [{ kind: 'strength', summary: '复杂架构', evidenceRefs: ['evidence:f'] }],
              pendingProposalCount: 0,
            },
          },
          availability: 'scarce',
          effect: 'advisory',
          reasons: [{ code: 'quota', summary: '额度紧张', sourceRefs: ['signal:1'] }],
        }),
        { displayName: '缅因猫 Sol', nickname: '小太阳·砚砚' },
      ),
      toTeamMemberRow(absentProfileCandidate, { displayName: '布偶猫 Opus 5', nickname: '宪宪' }),
    ];

    expect(countTeamMembers(rows)).toEqual({ all: 3, attention: 2, absent: 1 });
    expect(filterTeamMembers(rows, { query: '', filter: 'absent' }).map((row) => row.identity.catId)).toEqual([
      'opus5',
    ]);
    expect(filterTeamMembers(rows, { query: '', filter: 'attention' }).map((row) => row.identity.catId)).toEqual([
      'codex-sol',
      'opus5',
    ]);
    expect(filterTeamMembers(rows, { query: '跨仓', filter: 'all' }).map((row) => row.identity.catId)).toEqual([
      'codex-terra',
    ]);
    expect(filterTeamMembers(rows, { query: '小太阳·砚砚', filter: 'all' }).map((row) => row.identity.catId)).toEqual([
      'codex-sol',
    ]);
    expect(filterTeamMembers(rows, { query: '不存在的猫', filter: 'all' })).toEqual([]);
  });
});
