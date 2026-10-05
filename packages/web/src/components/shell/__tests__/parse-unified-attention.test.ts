import { describe, expect, it } from 'vitest';
import { parseUnifiedAttentionRead } from '../parse-unified-attention';

const source = (overrides: Record<string, unknown> = {}) => ({
  status: 'available',
  startedAt: 1,
  observedAt: 2,
  coverage: 'all_registered_F246_producers',
  exhaustiveness: 'complete',
  ...overrides,
});

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    status: 'available',
    scope: 'owner_all_projects',
    identity: { ownerUserId: 'owner-1' },
    observedAt: 3,
    sources: { approvals: source(), needsMe: source({ coverage: 'current_linked_F310_five_producers' }) },
    readWindow: { startedAt: 1, endedAt: 3, consistency: 'independent_source_reads' },
    consistency: { state: 'verified', reasons: [] },
    items: [
      {
        decisionRef: 'approval:F309:p1',
        kind: 'approval',
        summary: '一件',
        linkedNeedsMe: [],
        approval: { proposalId: 'p1', sourceFeatureId: 'F309' },
      },
    ],
    totalCount: 1,
    page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
    ...overrides,
  };
}

describe('parseUnifiedAttentionRead — a body is a read only if it is a version-1 read', () => {
  it('accepts a well-formed read and keeps extra fields the producer may add', () => {
    const parsed = parseUnifiedAttentionRead(body({ approvalCount: 1, futureField: true }));
    expect(parsed?.identity.ownerUserId).toBe('owner-1');
    expect(parsed?.totalCount).toBe(1);
    expect(parsed?.items).toHaveLength(1);
  });

  it('accepts a read with no totalCount and with no approval on an item', () => {
    const parsed = parseUnifiedAttentionRead(
      body({
        totalCount: undefined,
        items: [{ decisionRef: 'f306:s:1', kind: 'judgment', summary: 's', linkedNeedsMe: [] }],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.totalCount).toBeUndefined();
  });

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['an array', []],
    ['another version', body({ version: 2 })],
    ['an unknown overall status', body({ status: 'ok' })],
    ['a missing owner identity', body({ identity: {} })],
    ['a blank owner identity', body({ identity: { ownerUserId: ' ' } })],
    ['a different scope', body({ scope: 'one_project' })],
    ['a missing source', body({ sources: { approvals: source() } })],
    ['an unknown source status', body({ sources: { approvals: source({ status: 'fine' }), needsMe: source() } })],
    [
      'an unknown exhaustiveness',
      body({ sources: { approvals: source({ exhaustiveness: 'all' }), needsMe: source() } }),
    ],
    ['an unknown consistency', body({ consistency: { state: 'maybe', reasons: [] } })],
    ['items that are not an array', body({ items: {} })],
    ['an item with no decisionRef', body({ items: [{ kind: 'approval', summary: 's', linkedNeedsMe: [] }] })],
    [
      'an item of an unknown kind',
      body({ items: [{ decisionRef: 'x', kind: 'chat', summary: 's', linkedNeedsMe: [] }] }),
    ],
    [
      'an item whose linkedNeedsMe is not an array',
      body({ items: [{ decisionRef: 'x', kind: 'repair', summary: 's' }] }),
    ],
    [
      'an approval with no proposalId',
      body({ items: [{ decisionRef: 'x', kind: 'approval', summary: 's', linkedNeedsMe: [], approval: {} }] }),
    ],
    ['a negative totalCount', body({ totalCount: -1 })],
    ['a fractional totalCount', body({ totalCount: 1.5 })],
    ['a missing page', body({ page: undefined })],
  ])('rejects %s, so it can never be read as an empty success', (_label, input) => {
    expect(parseUnifiedAttentionRead(input)).toBeNull();
  });
});
