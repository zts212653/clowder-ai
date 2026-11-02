import type { RichCardBlock } from '@cat-cafe/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { readSettledOriginalBlock } from '../settled-original-block';
import type { SettledResultItem } from '../settled-results-source';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
afterEach(() => vi.mocked(apiFetch).mockReset());
function fixture(feature: 'F225' | 'F231' | 'F276') {
  const item: SettledResultItem = {
    sourceFeatureId: feature,
    proposalId: 'p',
    ownerUserId: 'owner',
    requesterCatId: 'codex61-sol',
    summary: 'Original',
    resolution: 'accepted',
    materialization: { state: 'outcome_unknown' },
    createdAt: 100,
    decidedAt: 200,
    decidedBy: 'owner',
    detail: {},
    navigation: {
      state: 'anchored',
      approvalCardRef: { threadId: 'thread', messageId: 'card' },
      originRef: { kind: 'message', threadId: 'thread', messageId: 'source' },
    },
  };
  const block: RichCardBlock = {
    kind: 'card',
    v: 1,
    id: `${feature === 'F225' ? 'handoff' : feature === 'F276' ? 'person-memory' : 'profile-update'}-p`,
    title: 'Original',
    bodyMarkdown: 'Original notes and proposed change',
    meta: {
      ...(feature === 'F276' ? { candidateId: 'p' } : {}),
      approval: { producerId: feature, canonicalProposalId: 'p' },
    },
    actions: [{ label: 'Approve', action: 'writer' }],
  };
  return {
    item,
    block,
    message: {
      id: 'card',
      userId: 'owner',
      catId: 'codex61-sol',
      threadId: 'thread',
      timestamp: 100,
      extra: { rich: { blocks: [block] } },
    },
  };
}
it.each([
  'F225',
  'F231',
  'F276',
] as const)('restores the exact %s original publication as read-only context after an external decision', async (feature) => {
  const { item, block, message } = fixture(feature);
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ messages: [message], hasMore: false }));
  const source = await readSettledOriginalBlock(item, new AbortController().signal);
  expect(source).toEqual({ ...block, actions: undefined });
  expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method)).toBe(true);
});
it.each([
  'owner',
  'cat',
  'deleted',
  'stamp',
  'duplicate',
] as const)('refuses a %s mismatch instead of restoring another original card', async (kind) => {
  const { item, message } = fixture('F231');
  const m = structuredClone(message);
  if (kind === 'owner') m.userId = 'foreign';
  if (kind === 'cat') m.catId = 'foreign';
  if (kind === 'stamp')
    m.extra.rich.blocks[0].meta = { approval: { producerId: 'F231', canonicalProposalId: 'foreign' } };
  const messages = [{ ...m, ...(kind === 'deleted' ? { deletedAt: 300 } : {}) }];
  if (kind === 'duplicate') messages.push(m);
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ messages, hasMore: false }));
  expect(await readSettledOriginalBlock(item, new AbortController().signal)).toBeNull();
});
it('stops repeated pagination cursors without inventing a source', async () => {
  const { item } = fixture('F225');
  vi.mocked(apiFetch).mockImplementation(async () =>
    Response.json({ messages: [{ id: 'older', timestamp: 50 }], hasMore: true }),
  );
  expect(await readSettledOriginalBlock(item, new AbortController().signal)).toBeNull();
  expect(apiFetch).toHaveBeenCalledTimes(2);
});
