import { describe, expect, it, vi } from 'vitest';
import { composerInsertFromRecall, requestTrueRecall } from '@/utils/true-recall';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: api }));

describe('recall hands the message back to the browser draft', () => {
  it('names the draft slot revision, replaces the slot, and inserts only the recalled message', async () => {
    const draft = { threadId: 'pdl-test', text: 'recalled words', replyTo: 'parent-1', revision: 8 };
    api
      .mockResolvedValueOnce({ ok: true, json: async () => ({ draft: { text: 'older slot' }, revision: 7 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ verdict: 'zero_exposure', draft, queue: [] }) });
    const result = await requestTrueRecall({ threadId: 'pdl-test', messageId: 'message-1' });
    expect(api.mock.calls.map((call) => call[0])).toEqual([
      '/api/threads/pdl-test/composer-draft',
      '/api/messages/message-1/recall',
    ]);
    expect(JSON.parse(api.mock.calls[1][1].body)).toEqual({
      threadId: 'pdl-test',
      expectedDraftRevision: 7,
      merge: 'replace',
    });
    expect(composerInsertFromRecall(result!)).toEqual({
      threadId: 'pdl-test',
      text: 'recalled words',
      replyToId: 'parent-1',
    });
  });
});
