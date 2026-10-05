/**
 * F322 S3-2b-1a: when may the 待办 panel hand an approval to the original card?
 *
 * The panel shows what the unified read says; the original card acts through the Approval Hub store, which looks the
 * proposal up in its own `items` for the endpoint, the request body and the lifecycle. Those are two copies of one fact
 * read at different moments. The card may be hosted only when the store's copy is the same decision the user is looking at:
 * same proposal, same producer, same owner (the read's verified identity, because the read carries none on the item),
 * same version, same lifecycle, same ability to act, not expired, and the same credentials the producer will check when the
 * button is pressed. Anything that differs, is missing, or cannot be told is "unmatched": never a default match.
 */
import type { ApprovalHubItem, UnifiedAttentionVisibleApproval } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';
import { parseUnifiedAttentionRead } from '../../parse-unified-attention';
import { isHostableApproval, matchHostedApproval } from '../approval-match';

const OWNER = 'owner-1';
const NOW = 1_000_000;

const base = {
  navigation: anchoredApprovalNavigation('thread-src'),
  requesterCatId: 'opus',
  resolution: 'open',
  materialization: { state: 'not_started' },
  createdAt: 500_000,
} as const;

const GENERIC: ApprovalHubItem = {
  ...base,
  ownerUserId: OWNER,
  proposalId: 'p-generic',
  sourceFeatureId: 'F128',
  summary: 'New thread: 记一条品味',
  detail: {},
  inlineApprovable: true,
};
const MEETING: ApprovalHubItem = {
  ...base,
  ownerUserId: OWNER,
  proposalId: 'p-meeting',
  sourceFeatureId: 'F292',
  decisionMode: 'meeting-intake',
  summary: '整理会议：Weekly sync',
  detail: { revision: 3, judgmentState: 'unresolved' },
  inlineApprovable: false,
};
const CONFLICT = {
  version: 1,
  reason: 'existing-entity-change',
  fingerprint: 'a'.repeat(64),
  allowedActions: ['merge-aliases', 'replace', 'reject'],
  canonicalReplacementRequiredFor: [] as string[],
};
const ENTITY: ApprovalHubItem = {
  ...base,
  ownerUserId: OWNER,
  proposalId: 'p-entity',
  sourceFeatureId: 'F260',
  summary: 'Entity proposal: 沉迷护栏',
  detail: { entityId: 'concept:沉迷护栏', conflict: CONFLICT },
  inlineApprovable: true,
};
const PERSON: ApprovalHubItem = {
  ...base,
  ownerUserId: OWNER,
  proposalId: 'p-person',
  sourceFeatureId: 'F276',
  decisionMode: 'claim-select',
  summary: '记住人物：黄挺',
  detail: { displayName: '黄挺', remainingDraftIds: ['d1', 'd2', 'd3'] },
  inlineApprovable: true,
};

/** What the unified read carries for the same item: everything except the owner, which the read's identity supplies. */
const asRead = (item: ApprovalHubItem): UnifiedAttentionVisibleApproval =>
  // Filtered by key, not destructured away: the web build's ESLint rejects an unused destructured name even with a leading "_".
  Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'ownerUserId')) as UnifiedAttentionVisibleApproval;

const match = (
  read: ApprovalHubItem | UnifiedAttentionVisibleApproval,
  store: readonly ApprovalHubItem[],
  overrides: { owner?: string; now?: number } = {},
) =>
  matchHostedApproval({
    read: 'ownerUserId' in read ? asRead(read) : read,
    readOwnerUserId: overrides.owner ?? OWNER,
    storeItems: store,
    now: overrides.now ?? NOW,
  });

const withDetail = (item: ApprovalHubItem, detail: Record<string, unknown>): ApprovalHubItem => ({
  ...item,
  detail: { ...item.detail, ...detail },
});

describe('matchHostedApproval', () => {
  describe('the same decision, whichever producer owns it', () => {
    it.each([
      GENERIC,
      MEETING,
      ENTITY,
      PERSON,
    ])('matches $sourceFeatureId when the store holds the same decision', (item) => {
      const result = match(item, [item]);
      expect(result).toEqual({ kind: 'matched', item });
    });

    it('returns the store copy, so what is shown and what the actions act on are the same object', () => {
      const store = { ...GENERIC };
      const result = match(GENERIC, [store]);
      expect(result.kind === 'matched' && result.item).toBe(store);
    });

    it('finds the right one among others, and does not confuse a different producer with the same proposal id', () => {
      const lookalike: ApprovalHubItem = { ...GENERIC, sourceFeatureId: 'F193' };
      expect(match(GENERIC, [MEETING, lookalike, PERSON, GENERIC]).kind).toBe('matched');
      expect(match(GENERIC, [lookalike])).toMatchObject({ kind: 'unmatched', reason: 'not_in_store' });
    });

    it('does not mind the order of a set the producer treats as a set', () => {
      const reordered = withDetail(PERSON, { remainingDraftIds: ['d3', 'd1', 'd2'] });
      expect(match(PERSON, [reordered]).kind).toBe('matched');
      const actions = { ...CONFLICT, allowedActions: ['reject', 'replace', 'merge-aliases'] };
      expect(match(ENTITY, [withDetail(ENTITY, { conflict: actions })]).kind).toBe('matched');
    });
  });

  describe('not the same decision', () => {
    it('is unmatched when the store has nothing for it (the store has not caught up, or never will)', () => {
      expect(match(GENERIC, [])).toEqual({ kind: 'unmatched', reason: 'not_in_store' });
    });

    it('is unmatched when the store belongs to a different owner than the read verified', () => {
      expect(match(GENERIC, [{ ...GENERIC, ownerUserId: 'someone-else' }])).toMatchObject({
        kind: 'unmatched',
        reason: 'owner',
      });
      expect(match(GENERIC, [GENERIC], { owner: 'someone-else' })).toMatchObject({
        kind: 'unmatched',
        reason: 'owner',
      });
    });

    it.each([
      ['createdAt', { createdAt: 500_001 }, 'identity'],
      ['decisionMode', { decisionMode: 'claim-select' as const }, 'capability'],
      ['inlineApprovable', { inlineApprovable: false }, 'capability'],
      ['resolution', { resolution: 'accepted' as const }, 'lifecycle'],
      [
        'materialization',
        { materialization: { state: 'outcome_unknown' } as ApprovalHubItem['materialization'] },
        'lifecycle',
      ],
      ['expiresAt', { expiresAt: 2_000_000 }, 'version'],
      ['summary', { summary: '换了一句话' }, 'version'],
    ])('is unmatched when the store differs in %s', (_field, change, reason) => {
      expect(match(GENERIC, [{ ...GENERIC, ...change }])).toMatchObject({ kind: 'unmatched', reason });
    });
  });

  describe('expiry is judged at the moment asked, not when the card was drawn', () => {
    const expiring = { ...GENERIC, expiresAt: 1_500_000 };

    it('matches while it has not expired, including the instant it expires (the card itself says expired only after)', () => {
      expect(match(expiring, [expiring], { now: 1_499_999 }).kind).toBe('matched');
      expect(match(expiring, [expiring], { now: 1_500_000 }).kind).toBe('matched');
    });

    it('is unmatched once it has expired, even though both copies still agree', () => {
      expect(match(expiring, [expiring], { now: 1_500_001 })).toEqual({ kind: 'unmatched', reason: 'expired' });
    });
  });

  describe("the producer's own credentials: equal createdAt and lifecycle are not enough", () => {
    it('F292: a different revision is not the same decision, and a missing or unreadable one cannot be told', () => {
      expect(match(MEETING, [withDetail(MEETING, { revision: 4 })])).toMatchObject({
        kind: 'unmatched',
        reason: 'credentials',
        field: 'revision',
      });
      expect(match(MEETING, [withDetail(MEETING, { revision: undefined })])).toMatchObject({ reason: 'credentials' });
      expect(
        match(withDetail(MEETING, { revision: 'three' }), [withDetail(MEETING, { revision: 'three' })]),
      ).toMatchObject({
        reason: 'credentials',
      });
    });

    it('F260: a different fingerprint, allowed actions or required replacements is not the same decision', () => {
      for (const [field, conflict] of [
        ['fingerprint', { ...CONFLICT, fingerprint: 'b'.repeat(64) }],
        ['allowedActions', { ...CONFLICT, allowedActions: ['merge-aliases', 'reject'] }],
        ['canonicalReplacementRequiredFor', { ...CONFLICT, canonicalReplacementRequiredFor: ['concept:x'] }],
      ] as const) {
        expect(match(ENTITY, [withDetail(ENTITY, { conflict })])).toMatchObject({
          kind: 'unmatched',
          reason: 'credentials',
          field,
        });
      }
    });

    it('F260: a conflict on one side only, or one that cannot be read, is not a match', () => {
      expect(match(ENTITY, [withDetail(ENTITY, { conflict: undefined })])).toMatchObject({ reason: 'credentials' });
      const readWithout = withDetail(ENTITY, { conflict: undefined });
      expect(match(readWithout, [ENTITY])).toMatchObject({ reason: 'credentials' });
      const unreadable = withDetail(ENTITY, { conflict: { fingerprint: 7 } });
      expect(match(unreadable, [unreadable])).toMatchObject({ reason: 'credentials' });
    });

    it('F260: a plain entity proposal with no conflict on either side matches; there is no credential to compare', () => {
      const plain = withDetail(ENTITY, { conflict: undefined });
      expect(match(plain, [plain]).kind).toBe('matched');
    });

    it('F276: a different set of remaining drafts is not the same decision, and a missing list cannot be told', () => {
      expect(match(PERSON, [withDetail(PERSON, { remainingDraftIds: ['d1', 'd2'] })])).toMatchObject({
        kind: 'unmatched',
        reason: 'credentials',
        field: 'remainingDraftIds',
      });
      expect(match(PERSON, [withDetail(PERSON, { remainingDraftIds: ['d1', 'd2', 'd3', 'd4'] })])).toMatchObject({
        reason: 'credentials',
      });
      const without = withDetail(PERSON, { remainingDraftIds: undefined });
      expect(match(without, [without])).toMatchObject({ reason: 'credentials' });
      const notStrings = withDetail(PERSON, { remainingDraftIds: [1, 2] });
      expect(match(notStrings, [notStrings])).toMatchObject({ reason: 'credentials' });
    });

    it('a producer with no extra credential matches on identity, lifecycle and capability alone', () => {
      const other = withDetail(GENERIC, { anything: 'the producer keeps to itself' });
      expect(match(GENERIC, [other]).kind).toBe('matched');
    });
  });

  it('never defaults to a match: an unrecognised producer whose copies differ in identity is unmatched', () => {
    const odd = { ...GENERIC, sourceFeatureId: 'F9999' as ApprovalHubItem['sourceFeatureId'] };
    expect(match(odd, [{ ...odd, createdAt: 1 }])).toMatchObject({ kind: 'unmatched', reason: 'identity' });
  });
});

describe('isHostableApproval', () => {
  it.each([
    ['an inline-approvable generic proposal', GENERIC, true],
    ['an F260 conflict that can be resolved inline', ENTITY, true],
    ['an F276 claim selection', PERSON, true],
    ['an F292 meeting intake, which is not inline-approvable but decides in its own card', MEETING, true],
  ])('hosts %s', (_name, item, expected) => {
    expect(isHostableApproval(asRead(item))).toBe(expected);
  });

  it('does not host what is already settled', () => {
    expect(isHostableApproval(asRead({ ...GENERIC, resolution: 'accepted' }))).toBe(false);
    expect(isHostableApproval(asRead({ ...MEETING, resolution: 'rejected' }))).toBe(false);
  });

  it('does not host something that cannot be decided inline and is not one of the producers with its own decision card', () => {
    expect(isHostableApproval(asRead({ ...GENERIC, inlineApprovable: false }))).toBe(false);
  });

  it('does not host a producer whose decision belongs on its own origin card', () => {
    const runtime: ApprovalHubItem = { ...GENERIC, sourceFeatureId: 'F306', inlineApprovable: true };
    expect(isHostableApproval(asRead(runtime))).toBe(false);
  });

  it('does not host a producer this build does not know', () => {
    const odd = { ...GENERIC, sourceFeatureId: 'F9999' as ApprovalHubItem['sourceFeatureId'] };
    expect(isHostableApproval(asRead(odd))).toBe(false);
  });
});

/**
 * Fail closed at the match boundary. The unified read's wire decoder admits any row that carries an address; it does not
 * promise the rest of the row is whole, and TypeScript's types do not exist at runtime. The rule "missing or unreadable is
 * unmatched" therefore has to hold for what the decoder really lets through, and for a store copy that is not whole either.
 * (The first three cases are the reviewer's regression, written against the real decoder rather than a hand-built row.)
 */
describe('addressed but unreadable approval data is unmatched, never a throw', () => {
  const decodedApproval = (change: Record<string, unknown>): UnifiedAttentionVisibleApproval => {
    const visible = asRead(MEETING);
    const source = { status: 'available', exhaustiveness: 'complete' };
    const body = parseUnifiedAttentionRead({
      version: 1,
      scope: 'owner_all_projects',
      status: 'available',
      identity: { ownerUserId: OWNER },
      sources: { approvals: source, needsMe: source },
      consistency: { state: 'verified', reasons: [] },
      items: [
        {
          decisionRef: 'approval:F292:p-meeting',
          kind: 'approval',
          summary: MEETING.summary,
          approval: { ...visible, ...change },
          linkedNeedsMe: [],
        },
      ],
      totalCount: 1,
      page: { hasMore: false },
    });
    if (!body?.items[0].approval) throw new Error('the existing decoder did not admit this addressed approval');
    return body.items[0].approval;
  };
  const ask = (read: UnifiedAttentionVisibleApproval, store: readonly ApprovalHubItem[] = [MEETING]) =>
    matchHostedApproval({ read, readOwnerUserId: OWNER, storeItems: store, now: NOW });
  const broken = (change: Record<string, unknown>): ApprovalHubItem => ({ ...MEETING, ...change }) as ApprovalHubItem;

  it('still matches, and returns the store object, for the fully readable version of the same row', () => {
    const result = ask(decodedApproval({}));
    expect(result.kind === 'matched' && result.item).toBe(MEETING);
  });

  it.each([
    ['no materialization', { materialization: undefined }],
    ['a null detail', { detail: null }],
  ])('an admitted row with %s is unmatched, not a throw', (_name, change) => {
    const read = decodedApproval(change);
    let result: ReturnType<typeof ask> | undefined;
    expect(() => {
      result = ask(read);
    }).not.toThrow();
    expect(result).toMatchObject({ kind: 'unmatched' });
  });

  it.each([
    ['no materialization', { materialization: undefined }, 'lifecycle'],
    ['a materialization without a state', { materialization: {} }, 'lifecycle'],
    ['a null detail', { detail: null }, 'credentials'],
    ['a detail that is not an object', { detail: 'revision 3' }, 'credentials'],
    ['a detail that is an array', { detail: [3] }, 'credentials'],
    ['no createdAt', { createdAt: undefined }, 'identity'],
    ['an expiresAt that is not a time', { expiresAt: 'tomorrow' }, 'version'],
  ])('a store copy with %s is unmatched (%s), not a throw', (_name, change, reason) => {
    const read = asRead(MEETING);
    expect(() => ask(read, [broken(change)])).not.toThrow();
    expect(ask(read, [broken(change)])).toMatchObject({ kind: 'unmatched', reason });
  });

  it('two copies that are equally unreadable are still unmatched: unreadable on both sides is not "the same"', () => {
    const noTime = broken({ createdAt: undefined });
    expect(ask(asRead(noTime), [noTime])).toMatchObject({ kind: 'unmatched', reason: 'identity' });
    const noLifecycle = broken({ materialization: undefined });
    expect(ask(asRead(noLifecycle), [noLifecycle])).toMatchObject({ kind: 'unmatched', reason: 'lifecycle' });
    const noDetail = broken({ detail: null });
    expect(ask(asRead(noDetail), [noDetail])).toMatchObject({ kind: 'unmatched', reason: 'credentials' });
    // 'tomorrow' === 'tomorrow', and 'tomorrow' < now is false: without a readability check this would pass as "not expired".
    for (const expiresAt of ['tomorrow', Number.NaN, Number.POSITIVE_INFINITY, null]) {
      const noExpiry = broken({ expiresAt });
      expect(ask(asRead(noExpiry), [noExpiry])).toMatchObject({ kind: 'unmatched', reason: 'version' });
    }
  });

  it('a generic producer whose card reads its detail is refused when either copy has no detail object', () => {
    const noDetail = { ...GENERIC, detail: null } as unknown as ApprovalHubItem;
    expect(() => match(asRead(GENERIC), [noDetail])).not.toThrow();
    expect(match(asRead(GENERIC), [noDetail])).toMatchObject({ kind: 'unmatched', reason: 'credentials' });
    expect(match(asRead(noDetail), [GENERIC])).toMatchObject({ kind: 'unmatched', reason: 'credentials' });
  });

  it('a store list holding a hole does not stop the right item being found, or crash the search', () => {
    const withHoles = [null, undefined, 3, GENERIC] as unknown as ApprovalHubItem[];
    expect(() => match(asRead(GENERIC), withHoles)).not.toThrow();
    expect(match(asRead(GENERIC), withHoles).kind).toBe('matched');
  });
});
