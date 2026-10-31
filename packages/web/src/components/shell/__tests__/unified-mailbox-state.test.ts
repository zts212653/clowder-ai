import type { UnifiedAttentionReadV1, UnifiedAttentionSourceRead } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import {
  deriveMailboxPanelState,
  deriveMailboxState,
  type MailboxRead,
  type MailboxState,
  mailboxStateText,
  sourceStatusText,
} from '../unified-mailbox-state';

const source = (overrides: Partial<UnifiedAttentionSourceRead> = {}): UnifiedAttentionSourceRead => ({
  status: 'available',
  startedAt: 1,
  observedAt: 2,
  coverage: 'all_registered_F246_producers',
  exhaustiveness: 'complete',
  ...overrides,
});

const item = (n: number): UnifiedAttentionReadV1['items'][number] => ({
  decisionRef: `approval:F309:p${n}`,
  kind: 'approval',
  summary: `事项 ${n}`,
  linkedNeedsMe: [],
});

function read(overrides: Partial<UnifiedAttentionReadV1> = {}): UnifiedAttentionReadV1 {
  return {
    version: 1,
    status: 'available',
    scope: 'owner_all_projects',
    identity: { ownerUserId: 'owner-1' },
    observedAt: 3,
    sources: {
      structuredChoices: source({ coverage: 'pending_f306_structured_choices' }),
      approvals: source(),
      needsMe: source({ coverage: 'current_linked_F310_five_producers' }),
    },
    readWindow: { startedAt: 1, endedAt: 3, consistency: 'independent_source_reads' },
    consistency: { state: 'verified', reasons: [] },
    items: [],
    attentionCount: overrides.totalCount,
    page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
    ...overrides,
  };
}

const ok = (overrides: Partial<UnifiedAttentionReadV1> = {}): MailboxRead => ({ kind: 'ok', read: read(overrides) });
const derive = (r: MailboxRead): MailboxState => deriveMailboxState(r);

describe('deriveMailboxState — what the one rail entry may claim', () => {
  it('uses the authority-qualified count for the badge and keeps every panel row counted separately', () => {
    const result = ok({
      items: [{ decisionRef: 'mention:one', kind: 'user_mention', summary: '@you', linkedNeedsMe: [] }],
      totalCount: 1,
      attentionCount: 0,
    });
    expect(derive(result)).toEqual({ kind: 'empty' });
    expect(deriveMailboxPanelState(result)).toEqual({ kind: 'has-items', count: 1, partial: false });
    const legacy = ok({ items: [item(1)], totalCount: 1, attentionCount: undefined });
    expect(derive(legacy)).toEqual({ kind: 'has-items', count: null, partial: false });
    expect(deriveMailboxPanelState(legacy)).toEqual({ kind: 'has-items', count: 1, partial: false });
  });

  it('keeps the badge on visible decisions while the panel shows ignored decisions', () => {
    const result = ok({
      items: [item(1), item(2), item(3)],
      totalCount: 8,
      attentionCount: 6,
      sources: {
        structuredChoices: source({ coverage: 'pending_f306_structured_choices' }),
        approvals: source(),
        needsMe: source(),
        personalPreferences: source({ coverage: 'owner_personal_ignored_items' }),
      },
      personalView: {
        mode: 'ignored',
        preferenceRevision: 9,
        originalTotalCount: 10,
        visibleTotalCount: 2,
        ignoredTotalCount: 8,
        originalAttentionCount: 6,
        visibleAttentionCount: 0,
        ignoredAttentionCount: 6,
      },
    });
    expect(derive(result)).toEqual({ kind: 'empty' });
    expect(deriveMailboxPanelState(result)).toEqual({ kind: 'has-items', count: 8, partial: false });
  });

  it('never reinterprets an older attention number without the qualified source, and withdraws counts for a failed source', () => {
    const legacy = ok({
      totalCount: 1,
      attentionCount: 1,
      items: [{ decisionRef: 'mention:one', kind: 'user_mention', summary: '@you', linkedNeedsMe: [] }],
      sources: { approvals: source(), needsMe: source() },
    });
    expect(derive(legacy)).toEqual({ kind: 'partial' });
    const failed = ok({
      totalCount: 0,
      attentionCount: 0,
      status: 'partial',
      sources: {
        approvals: source(),
        needsMe: source(),
        structuredChoices: source({
          coverage: 'pending_f306_structured_choices',
          status: 'invalid',
          exhaustiveness: 'unknown',
        }),
      },
    });
    expect(derive(failed)).toEqual({ kind: 'partial' });
    expect(deriveMailboxPanelState(failed)).toEqual({ kind: 'partial' });
  });

  it('keeps the before-paging decision count even when the visible page contains only mention rows', () => {
    const result = ok({
      items: [{ decisionRef: 'mention:page', kind: 'user_mention', summary: '@you', linkedNeedsMe: [] }],
      totalCount: 14,
      attentionCount: 2,
      page: { offset: 12, limit: 1, scope: 'known_rows', hasMore: true },
    });
    expect(derive(result)).toEqual({ kind: 'has-items', count: 2, partial: false });
    expect(deriveMailboxPanelState(result)).toEqual({ kind: 'has-items', count: 14, partial: false });
  });
  it('first read is loading, never a zero or an empty claim', () => {
    expect(derive({ kind: 'loading' })).toEqual({ kind: 'loading' });
  });

  it('a route-level 401 is the only whole-read login signal', () => {
    expect(derive({ kind: 'failed', reason: 'unauthenticated' })).toEqual({ kind: 'login-required' });
  });

  it('any other failure (403, 5xx, network, wrong shape, identity mismatch) is unavailable, not login', () => {
    expect(derive({ kind: 'failed', reason: 'unavailable' })).toEqual({ kind: 'unavailable' });
  });

  it('prints the number only when the read carries totalCount, and prints exactly that number', () => {
    expect(derive(ok({ items: [item(1), item(2), item(3)], totalCount: 3 }))).toEqual({
      kind: 'has-items',
      count: 3,
      partial: false,
    });
    // paging: the first page holds 20 rows but the proven total is 25 — never use items.length as the total
    const page = Array.from({ length: 20 }, (_, n) => item(n));
    expect(
      derive(ok({ items: page, totalCount: 25, page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: true } })),
    ).toEqual({
      kind: 'has-items',
      count: 25,
      partial: false,
    });
  });

  it('confirmed rows without a totalCount say "count unconfirmed" and never invent a number', () => {
    expect(derive(ok({ items: [item(1), item(2)], consistency: { state: 'uncertain', reasons: ['x'] } }))).toEqual({
      kind: 'has-items',
      count: null,
      partial: false,
    });
  });

  it('does not trust a totalCount that arrives next to uncertain consistency', () => {
    expect(
      derive(ok({ items: [item(1)], totalCount: 1, consistency: { state: 'uncertain', reasons: ['x'] } })),
    ).toEqual({ kind: 'has-items', count: null, partial: false });
  });

  it('says empty only for a proven complete empty set', () => {
    expect(derive(ok({ items: [], totalCount: 0 }))).toEqual({ kind: 'empty' });
  });

  it('never says empty while rows exist, even if totalCount contradicts them', () => {
    expect(derive(ok({ items: [item(1)], totalCount: 0 }))).toEqual({ kind: 'has-items', count: null, partial: false });
  });

  it('does not say empty when a source cannot prove it read everything', () => {
    const unknownCoverage = ok({
      items: [],
      totalCount: 0,
      sources: {
        approvals: source({ exhaustiveness: 'unknown' }),
        needsMe: source({ coverage: 'current_linked_F310_five_producers' }),
      },
    });
    expect(derive(unknownCoverage)).toEqual({ kind: 'partial' });
    // consistency uncertain => the server omits totalCount; zero rows is then unproven, not empty
    expect(derive(ok({ items: [], consistency: { state: 'uncertain', reasons: ['x'] } }))).toEqual({
      kind: 'partial',
    });
  });

  it('partial read with rows shows the dot and says only part was read', () => {
    expect(
      derive(
        ok({
          status: 'partial',
          items: [item(1)],
          sources: {
            approvals: source({ status: 'unauthenticated', exhaustiveness: 'unknown' }),
            needsMe: source({ coverage: 'current_linked_F310_five_producers' }),
          },
        }),
      ),
    ).toEqual({ kind: 'has-items', count: null, partial: true });
  });

  it('partial read whose readable side is empty only says partial, with no dot', () => {
    expect(
      derive(
        ok({
          status: 'partial',
          items: [],
          sources: {
            approvals: source({ status: 'unavailable', exhaustiveness: 'unknown' }),
            needsMe: source({ coverage: 'current_linked_F310_five_producers' }),
          },
        }),
      ),
    ).toEqual({ kind: 'partial' });
  });

  it('a forbidden source is partial, never "needs login" and never empty', () => {
    expect(
      derive(
        ok({
          status: 'partial',
          sources: {
            approvals: source({ status: 'forbidden', exhaustiveness: 'unknown' }),
            needsMe: source({ coverage: 'current_linked_F310_five_producers' }),
          },
        }),
      ),
    ).toEqual({ kind: 'partial' });
  });

  it('structured all-unavailable read is unavailable and carries no dot', () => {
    expect(
      derive(
        ok({
          status: 'unavailable',
          sources: {
            approvals: source({ status: 'unavailable', exhaustiveness: 'unknown' }),
            needsMe: source({ status: 'invalid', exhaustiveness: 'unknown' }),
          },
        }),
      ),
    ).toEqual({ kind: 'unavailable' });
  });

  it('writes needs-login only when every source gave an explicit auth signal', () => {
    const both = ok({
      status: 'unavailable',
      sources: {
        approvals: source({ status: 'unauthenticated', exhaustiveness: 'unknown' }),
        needsMe: source({ status: 'unauthenticated', exhaustiveness: 'unknown' }),
      },
    });
    expect(derive(both)).toEqual({ kind: 'login-required' });
    const mixed = ok({
      status: 'unavailable',
      sources: {
        approvals: source({ status: 'unauthenticated', exhaustiveness: 'unknown' }),
        needsMe: source({ status: 'forbidden', exhaustiveness: 'unknown' }),
      },
    });
    expect(derive(mixed)).toEqual({ kind: 'unavailable' });
  });
});

describe('state wording — the short words of the 1.6 status board', () => {
  const cases: [MailboxState, string][] = [
    [{ kind: 'loading' }, '读取中'],
    [{ kind: 'has-items', count: 3, partial: false }, '3 件'],
    [{ kind: 'has-items', count: null, partial: false }, '数量未确认'],
    [{ kind: 'has-items', count: null, partial: true }, '仅部分读取 · 已确认有事'],
    [{ kind: 'empty' }, '暂无'],
    [{ kind: 'partial' }, '仅部分读取'],
    [{ kind: 'unavailable' }, '暂不可用'],
    [{ kind: 'login-required' }, '需要登录'],
  ];
  it.each(cases)('%j reads as %s', (state, text) => {
    expect(mailboxStateText(state)).toBe(text);
  });
});

describe('sourceStatusText — each source speaks for itself', () => {
  it('stays quiet for a complete available source', () => {
    expect(sourceStatusText(source())).toBeNull();
  });
  it('names the one side that could not be read', () => {
    expect(sourceStatusText(source({ status: 'unauthenticated', exhaustiveness: 'unknown' }))).toBe('需要登录');
    expect(sourceStatusText(source({ status: 'forbidden', exhaustiveness: 'unknown' }))).toBe('无权查看');
    expect(sourceStatusText(source({ status: 'unavailable', exhaustiveness: 'unknown' }))).toBe('暂不可用');
    expect(sourceStatusText(source({ status: 'invalid', exhaustiveness: 'unknown' }))).toBe('无法读取');
  });
  it('says partial for an available source that cannot prove full coverage', () => {
    expect(sourceStatusText(source({ exhaustiveness: 'partial' }))).toBe('仅部分读取');
    expect(sourceStatusText(source({ exhaustiveness: 'unknown' }))).toBe('仅部分读取');
  });
});
