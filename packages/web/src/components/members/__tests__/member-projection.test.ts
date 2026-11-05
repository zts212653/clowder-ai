import type { RoutingContextReadModelV1 } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { memberStatus, reorderMemberIds, routingSubjectName } from '../member-projection';

const cat = { id: 'member', roster: { available: true } } as CatData;
it('distinguishes routing preference subjects that share a visible name', () => {
  const cats = [
    { ...cat, id: 'codex61-sol', nickname: '小太阳·砚砚', displayName: 'Sol6.1' },
    { ...cat, id: 'codex6-sol', nickname: '小太阳·砚砚', displayName: 'Sol6' },
  ];
  expect(routingSubjectName({ type: 'cat', catId: 'codex61-sol' }, cats)).toBe('小太阳·砚砚 · codex61-sol');
  expect(routingSubjectName({ type: 'cat', catId: 'codex6-sol' }, cats)).toBe('小太阳·砚砚 · codex6-sol');
  expect(cats.map((item) => item.nickname)).toEqual(['小太阳·砚砚', '小太阳·砚砚']);
});
it('keeps unique, unknown and pool subject names while disambiguating nickname/display-name collisions', () => {
  const cats = [
    { ...cat, id: 'a', nickname: 'Shared', displayName: 'Alpha' },
    { ...cat, id: 'b', nickname: '', displayName: 'Shared' },
    { ...cat, id: 'c', nickname: 'Unique', displayName: 'Gamma' },
  ];
  expect(routingSubjectName({ type: 'cat', catId: 'b' }, cats)).toBe('Shared · b');
  expect(routingSubjectName({ type: 'cat', catId: 'c' }, cats)).toBe('Unique');
  expect(routingSubjectName({ type: 'cat', catId: 'missing' }, cats)).toBe('missing');
  expect(routingSubjectName({ type: 'quota_pool', poolId: 'weekly' }, cats, (id) => `Pool ${id}`)).toBe('Pool weekly');
});
function model(
  availability: 'available' | 'scarce' | 'unknown',
  freshness: 'fresh' | 'stale' | 'unknown' = 'fresh',
): RoutingContextReadModelV1 {
  return {
    v: 1,
    ownerId: 'owner',
    observedAt: 1,
    catalogRevision: 'revision',
    signalEvents: [],
    preferenceRevisions: [],
    resolution: {
      state: 'fresh',
      inputRevisionRef: 'input',
      sourceRefs: { signalEventIds: [], preferenceRevisionIds: [], dossierRevisions: [] },
      snapshot: {
        v: 1,
        ownerId: 'owner',
        observedAt: 1,
        catalogRevision: 'revision',
        candidates: [
          {
            binding: { v: 1, catId: 'member', providerId: 'openai', provenQuotaPools: [] },
            profile: { state: 'absent' },
            availability,
            freshness,
            effect: availability === 'available' ? 'eligible' : 'advisory',
            reasons: [],
            matchedPreferences: [],
          },
        ],
      },
    },
  };
}
describe('member status is only an owner projection', () => {
  it('does not present a newly created native teammate as usable without a successful connection', () => {
    const native = { ...cat, configurationSource: 'native_tool' as const };
    expect(memberStatus(native, model('available')).label).toBe('待验证');
  });
  it('recognizes a first successful native call even when no prior failure contributes candidate reasons', () => {
    const m = model('available');
    m.signalEvents = [
      {
        v: 1,
        eventId: 'first-success',
        commandId: 'first-success',
        ownerId: 'owner',
        subjectRef: { type: 'cat', catId: 'member' },
        source: 'dispatch_success',
        reasonCode: 'dispatch_success_probe',
        eventType: 'recovered',
        state: 'available',
        observedAt: 100,
        probeStartedAt: 90,
        evidenceRef: 'successful-invocation',
        closesSignalIds: [],
      },
    ];
    expect(memberStatus({ ...cat, configurationSource: 'native_tool' }, m, null, 101).label).toBe('可用');
  });
  it('does not turn missing, failed or stale facts into availability', () => {
    expect(memberStatus(cat, null).label).toBe('未确认');
    expect(memberStatus(cat, model('available'), 'read failed').label).toBe('未确认');
    expect(memberStatus(cat, model('available', 'stale')).label).toBe('未确认');
    expect(memberStatus(cat, model('unknown')).label).toBe('未确认');
    expect(memberStatus(cat, model('unknown', 'unknown')).detail).toBe('记录新鲜度未确认');
    expect(memberStatus({ ...cat, roster: { ...cat.roster!, available: false } }, null).label).toBe('已停用');
  });
  it('does not retain a live quota state after its exact source expires', () => {
    const m = model('scarce');
    if (m.resolution.state !== 'fresh') throw Error('fixture');
    m.resolution.snapshot.candidates[0].reasons = [
      { code: 'quota', summary: 'weekly_quota_low', sourceRefs: ['signal'] },
    ];
    m.signalEvents = [
      {
        v: 1,
        eventId: 'signal',
        commandId: 'command',
        ownerId: 'owner',
        subjectRef: { type: 'cat', catId: 'member' },
        reasonCode: 'weekly_quota_low',
        source: 'quota_probe',
        observedAt: 1,
        evidenceRef: 'evidence',
        eventType: 'asserted',
        state: 'scarce',
        validUntil: 100,
      },
    ];
    expect(memberStatus(cat, m, null, 99).label).toBe('额度紧张');
    expect(memberStatus(cat, m, null, 100).label).toBe('未确认');
  });
  it('reorders the full canonical list while preserving filtered-out members', () => {
    expect(reorderMemberIds(['a', 'disabled', 'b'], 'b', 'a')).toEqual(['b', 'a', 'disabled']);
    expect(reorderMemberIds(['a', 'b', 'c'], 'a', 'b')).toEqual(['b', 'a', 'c']);
    const ids = ['a', 'b'];
    expect(reorderMemberIds(ids, 'unknown', 'b')).toBe(ids);
  });
  it('honors recovery that closes the exact expired assertion referenced for history', () => {
    const m = model('available');
    if (m.resolution.state !== 'fresh') throw Error('fixture');
    m.resolution.snapshot.candidates[0].reasons = [
      { code: 'routing_signal_recovered', summary: 'weekly_quota_low', sourceRefs: ['recovery', 'old-assertion'] },
    ];
    m.signalEvents = [
      {
        v: 1,
        eventId: 'old-assertion',
        commandId: 'assert',
        ownerId: 'owner',
        subjectRef: { type: 'cat', catId: 'member' },
        reasonCode: 'weekly_quota_low',
        source: 'quota_probe',
        observedAt: 1,
        evidenceRef: 'assertion-source',
        eventType: 'asserted',
        state: 'scarce',
        validUntil: 100,
      },
      {
        v: 1,
        eventId: 'recovery',
        commandId: 'recover',
        ownerId: 'owner',
        subjectRef: { type: 'cat', catId: 'member' },
        reasonCode: 'weekly_quota_low',
        source: 'quota_probe',
        observedAt: 101,
        evidenceRef: 'recovery-source',
        eventType: 'recovered',
        state: 'available',
        closesSignalIds: ['old-assertion'],
      },
    ];
    const status = memberStatus(cat, m, null, 102);
    expect(status.label).toBe('可用');
    expect(status.until).toBeUndefined();
    expect(status.detail).toBe('已恢复');
  });
  it('uses the earlier reset or expiry boundary, matching the routing owner', () => {
    const m = model('scarce');
    if (m.resolution.state !== 'fresh') throw Error('fixture');
    m.resolution.snapshot.candidates[0].reasons = [
      { code: 'weekly_quota_low', summary: 'weekly_quota_low', sourceRefs: ['signal'] },
    ];
    m.signalEvents = [
      {
        v: 1,
        eventId: 'signal',
        commandId: 'command',
        ownerId: 'owner',
        subjectRef: { type: 'cat', catId: 'member' },
        reasonCode: 'weekly_quota_low',
        source: 'quota_probe',
        observedAt: 1,
        evidenceRef: 'evidence',
        eventType: 'asserted',
        state: 'scarce',
        validUntil: 100,
        resetAt: 80,
      },
    ];
    expect(memberStatus(cat, m, null, 79).until).toBe(80);
    expect(memberStatus(cat, m, null, 80).label).toBe('未确认');
  });
  it.each([
    'provider_error',
    'health_probe',
  ] as const)('keeps a successful implicit recovery available after the old %s deadline', (source) => {
    const m = model('available');
    if (m.resolution.state !== 'fresh') throw Error('fixture');
    m.resolution.snapshot.candidates[0].reasons = [
      { code: 'routing_signal_recovered', summary: 'dispatch_success_probe', sourceRefs: ['failed', 'success'] },
    ];
    m.signalEvents = [
      {
        v: 1,
        eventId: 'failed',
        commandId: 'fail',
        ownerId: 'owner',
        subjectRef: { type: 'cat', catId: 'member' },
        reasonCode: 'provider_error',
        source,
        observedAt: 100,
        evidenceRef: 'failure-source',
        eventType: 'asserted',
        state: 'unavailable',
        validUntil: 1000,
      },
      {
        v: 1,
        eventId: 'success',
        commandId: 'success',
        ownerId: 'owner',
        subjectRef: { type: 'cat', catId: 'member' },
        reasonCode: 'dispatch_success_probe',
        source: 'dispatch_success',
        observedAt: 400,
        probeStartedAt: 200,
        evidenceRef: 'success-source',
        eventType: 'recovered',
        state: 'available',
        closesSignalIds: [],
      },
    ];
    for (const now of [500, 1000, 1500]) {
      expect(memberStatus(cat, m, null, now)).toMatchObject({
        label: '已恢复',
        detail: '最近一次接活顺利完成',
        observedAt: 400,
        evidenceRef: 'success-source',
      });
      expect(memberStatus(cat, m, null, now).until).toBeUndefined();
    }
  });
});
