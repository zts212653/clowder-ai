import type { ContextAttachment } from '@cat-cafe/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { type ComposerDraft, useServerComposerDraft } from '../useServerComposerDraft';
import { cleanup, renderHook, waitFor } from './hook-host';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const quote = { v: 1, id: 'q1', kind: 'thread', threadId: 't9', title: 'Elsewhere' } as unknown as ContextAttachment;
const calls = () =>
  vi.mocked(apiFetch).mock.calls.map(([path, init]) => [init?.method ?? 'GET', String(path), init?.body]);

function mount(draft: ComposerDraft, empty = true) {
  const restore = vi.fn();
  const state = { draft };
  const hook = renderHook(() =>
    useServerComposerDraft({ threadId: 't1', enabled: true, draft: state.draft, composerEmpty: () => empty, restore }),
  );
  return { hook, restore, state };
}

it('fills an empty composer with the conversation draft saved on the server', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    Response.json({
      draft: {
        text: '写到一半',
        contentBlocks: [{ type: 'context_attachment', attachment: quote }],
        replyTo: 'm1',
        revision: 3,
      },
      revision: 3,
    }),
  );
  const { restore } = mount({ text: '', contexts: [] });
  await waitFor(() => expect(restore).toHaveBeenCalledWith({ text: '写到一半', contexts: [quote], replyTo: 'm1' }));
});

it('leaves a composer that already has words as it is', async () => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ draft: { text: 'saved', revision: 1 }, revision: 1 }));
  const { restore } = mount({ text: 'typing here', contexts: [] }, false);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
  expect(restore).not.toHaveBeenCalled();
});

it('writes edits back under the last revision and repeats once on the revision the server reports', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
    if (!init?.method) return Response.json({ draft: null, revision: 0 });
    const body = JSON.parse(String(init.body)) as { expectedRevision: number };
    return body.expectedRevision === 5
      ? Response.json({ draft: { text: 'new', revision: 6 } })
      : Response.json({ code: 'DRAFT_REVISION_MISMATCH', actualRevision: 5 }, { status: 409 });
  });
  const { hook, state } = mount({ text: '', contexts: [] });
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
  state.draft = { text: 'new', contexts: [quote] };
  hook.rerender();
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
  expect(calls().slice(1)).toEqual([
    [
      'PUT',
      '/api/threads/t1/composer-draft',
      JSON.stringify({
        expectedRevision: 0,
        text: 'new',
        contentBlocks: [{ type: 'context_attachment', attachment: quote }],
      }),
    ],
    [
      'PUT',
      '/api/threads/t1/composer-draft',
      JSON.stringify({
        expectedRevision: 5,
        text: 'new',
        contentBlocks: [{ type: 'context_attachment', attachment: quote }],
      }),
    ],
  ]);
});

it('deletes the saved draft of a conversation whose send the server took', async () => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ draft: { text: 'sent soon', revision: 2 }, revision: 2 }));
  const { hook } = mount({ text: 'sent soon', contexts: [] }, false);
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ draft: null, revision: 3 }));
  hook.result.current.clear('t1');
  await waitFor(() =>
    expect(calls()).toContainEqual([
      'DELETE',
      '/api/threads/t1/composer-draft',
      JSON.stringify({ expectedRevision: 2 }),
    ]),
  );
});
