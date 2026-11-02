import { describe, expect, it, vi } from 'vitest';
import type { apiFetch } from '@/utils/api-client';
import { readGroupDecisionThreads } from '../use-group-decisions';

const source = { status: 'available', exhaustiveness: 'complete' };
function approval(id: string, resolution = 'open') {
  return {
    decisionRef: `approval:F193:${id}`,
    kind: 'approval',
    summary: id,
    linkedNeedsMe: [],
    approval: {
      proposalId: id,
      resolution,
      navigation: { state: 'anchored', approvalCardRef: { threadId: id, messageId: 'message' } },
    },
  };
}
function body(items: ({ decisionRef: string } & Record<string, unknown>)[] = [], offset = 0, hasMore = false) {
  const total = offset + items.length + Number(hasMore);
  return {
    version: 1,
    status: 'available',
    scope: 'owner_all_projects',
    identity: { ownerUserId: 'owner' },
    observedAt: 3,
    sources: { approvals: source, needsMe: source, personalPreferences: source },
    personalView: {
      mode: 'visible',
      preferenceRevision: 8,
      originalTotalCount: total,
      visibleTotalCount: total,
      ignoredTotalCount: 0,
      originalAttentionCount: total,
      visibleAttentionCount: total,
      ignoredAttentionCount: 0,
    },
    readWindow: { startedAt: 1, endedAt: 3, consistency: 'independent_source_reads' },
    consistency: { state: 'verified', reasons: [] },
    items: items.map((item) => ({
      ...item,
      preferenceCoordinate: {
        kind: 'mailbox',
        decisionRef: item.decisionRef,
        version: `sha256:${'a'.repeat(64)}`,
      },
    })),
    totalCount: total,
    page: { offset, limit: 20, scope: 'known_rows', hasMore },
  };
}
const signal = () => new AbortController().signal;
describe('Group decision read keeps the pending owner truth', () => {
  it('uses the owner-visible view so an ignored decision stays hidden until restored or its version changes', async () => {
    let ignored = false;
    let version = 1;
    const request = vi.fn<typeof apiFetch>().mockImplementation(async (path) => {
      if (path === '/api/session') return Response.json({ userId: 'owner' });
      const visible = new URL(String(path), 'https://fixture.test').searchParams.get('personalView') === 'visible';
      return Response.json(body(visible && ignored && version === 1 ? [] : [approval('original-card')]));
    });
    expect([...(await readGroupDecisionThreads(signal(), request))]).toEqual(['original-card']);
    ignored = true;
    expect([...(await readGroupDecisionThreads(signal(), request))]).toEqual([]);
    ignored = false;
    expect([...(await readGroupDecisionThreads(signal(), request))]).toEqual(['original-card']);
    ignored = true;
    version = 2;
    expect([...(await readGroupDecisionThreads(signal(), request))]).toEqual(['original-card']);
  });
  it('reads all pages rather than mistaking the first twenty for all Groups', async () => {
    const request = vi.fn<typeof apiFetch>().mockImplementation(async (path) => {
      if (path === '/api/session') return Response.json({ userId: 'owner' });
      return Response.json(
        String(path).includes('offset=20')
          ? body([approval('last')], 20)
          : body(
              Array.from({ length: 20 }, (_, i) => approval(`thread-${i}`)),
              0,
              true,
            ),
      );
    });
    const ids = await readGroupDecisionThreads(signal(), request);
    expect(ids.size).toBe(21);
    expect(ids.has('last')).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
    for (const [path] of request.mock.calls.slice(1))
      expect(new URL(String(path), 'https://fixture.test').searchParams.get('personalView')).toBe('visible');
  });
  it('rejects a view the server did not confirm and a changed preference revision between pages', async () => {
    for (const missing of [true, false]) {
      const read = {
        ...body([approval('hidden')]),
        personalView: missing
          ? undefined
          : {
              mode: 'ignored',
              preferenceRevision: 8,
              originalTotalCount: 1,
              visibleTotalCount: 0,
              ignoredTotalCount: 1,
              originalAttentionCount: 1,
              visibleAttentionCount: 0,
              ignoredAttentionCount: 1,
            },
      };
      const request = vi
        .fn<typeof apiFetch>()
        .mockImplementation(async (path) => Response.json(path === '/api/session' ? { userId: 'owner' } : read));
      await expect(readGroupDecisionThreads(signal(), request)).rejects.toThrow();
    }
    const request = vi.fn<typeof apiFetch>().mockImplementation(async (path) => {
      if (path === '/api/session') return Response.json({ userId: 'owner' });
      const later = String(path).includes('offset=20');
      const read = later
        ? body([approval('last')], 20)
        : body(
            Array.from({ length: 20 }, (_, i) => approval(`t-${i}`)),
            0,
            true,
          );
      read.personalView.preferenceRevision = later ? 9 : 8;
      return Response.json(read);
    });
    await expect(readGroupDecisionThreads(signal(), request)).rejects.toThrow();
  });
  it('does not keep a decision after acceptance and never treats ordinary mentions as pending decisions', async () => {
    const request = vi
      .fn<typeof apiFetch>()
      .mockImplementation(async (path) =>
        Response.json(
          path === '/api/session' ? { userId: 'owner' } : body([approval('open'), approval('accepted', 'accepted')]),
        ),
      );
    expect([...(await readGroupDecisionThreads(signal(), request))]).toEqual(['open']);
  });
  it('uses the original conversation for a pending structured question and ignores unanchored judgments', async () => {
    const question = {
      decisionRef: 'f306.runtime_interaction:question',
      kind: 'judgment',
      summary: 'Choose',
      linkedNeedsMe: [],
      choiceRequest: {
        interactionId: 'question',
        revision: 1,
        requesterCatId: 'codex61-sol',
        createdAt: 1,
        title: 'Choose',
        questions: [{ id: 'where', header: 'Place', question: 'Where?' }],
        cardRef: { threadId: 'question-thread', messageId: 'message', blockId: 'card' },
      },
    };
    const request = vi
      .fn<typeof apiFetch>()
      .mockImplementation(async (path) =>
        Response.json(
          path === '/api/session'
            ? { userId: 'owner' }
            : body([
                question,
                { decisionRef: 'unanchored', kind: 'judgment', summary: 'question-thread', linkedNeedsMe: [] },
              ]),
        ),
      );
    expect([...(await readGroupDecisionThreads(signal(), request))]).toEqual(['question-thread']);
  });
  it('withdraws the count on a foreign owner, partial read or malformed page', async () => {
    for (const changed of [
      { identity: { ownerUserId: 'foreign' } },
      { status: 'partial' },
      { page: { offset: 20, limit: 20, scope: 'known_rows', hasMore: false } },
    ]) {
      const request = vi
        .fn<typeof apiFetch>()
        .mockImplementation(async (path) =>
          Response.json(
            path === '/api/session' ? { userId: 'owner' } : { ...body([approval('should-not-leak')]), ...changed },
          ),
        );
      await expect(readGroupDecisionThreads(signal(), request)).rejects.toThrow();
    }
  });
});
