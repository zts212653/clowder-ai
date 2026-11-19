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
const writes = () => calls().filter(([method]) => method !== 'GET');
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Lets React run the renders and effects a rerender queued, optionally across some time. */
const flushed = async (ms = 0) => {
  await waitFor(() => {});
  if (ms) await settle(ms);
  await waitFor(() => {});
};

/** Mounts the hook the way the host does: a restore fills the composer, and the composer feeds the next render. */
function mount(draft: ComposerDraft, threadId = 't1') {
  const state = { draft, threadId };
  const host: { rerender?: () => void } = {};
  const restore = vi.fn((saved: ComposerDraft) => {
    state.draft = saved;
    host.rerender?.();
  });
  const hook = renderHook(() =>
    useServerComposerDraft({ threadId: state.threadId, enabled: true, draft: state.draft, restore }),
  );
  host.rerender = hook.rerender;
  return { hook, restore, state };
}

it('shows the draft the server keeps when the conversation opens, without writing it back', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    Response.json({
      draft: { text: '写到一半', contentBlocks: [{ type: 'context_attachment', attachment: quote }], replyTo: 'm1' },
      revision: 3,
    }),
  );
  const { restore } = mount({ text: '', images: [], contexts: [] });
  await waitFor(() =>
    expect(restore).toHaveBeenCalledWith(
      { text: '写到一半', images: [], contexts: [quote], replyTo: 'm1' },
      expect.any(Function),
    ),
  );
  await flushed(700);
  expect(writes()).toEqual([]);
});

it('empties what this browser kept when the draft was sent or cleared elsewhere', async () => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ draft: null, revision: 4 }));
  const { restore } = mount({ text: 'stale words', images: [], contexts: [] });
  await waitFor(() =>
    expect(restore).toHaveBeenCalledWith({ text: '', images: [], contexts: [] }, expect.any(Function)),
  );
  await flushed(700);
  expect(writes()).toEqual([]);
});

it('keeps words typed before the server answered and writes them back', async () => {
  let answer: (response: Response) => void = () => {};
  vi.mocked(apiFetch).mockImplementation((_path, init) =>
    init?.method
      ? Promise.resolve(Response.json({ draft: { revision: 3 } }))
      : new Promise<Response>((resolve) => {
          answer = resolve;
        }),
  );
  const { hook, restore, state } = mount({ text: '', images: [], contexts: [] });
  state.draft = { text: 'typed first', images: [], contexts: [] };
  hook.rerender();
  await flushed();
  answer(Response.json({ draft: { text: 'older' }, revision: 2 }));
  await waitFor(() =>
    expect(writes()).toEqual([
      ['PUT', '/api/threads/t1/composer-draft', JSON.stringify({ expectedRevision: 2, text: 'typed first' })],
    ]),
  );
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
  const { hook, state } = mount({ text: '', images: [], contexts: [] });
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
  state.draft = { text: 'new', images: [], contexts: [quote] };
  hook.rerender();
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
  const body = (revision: number) =>
    JSON.stringify({
      expectedRevision: revision,
      text: 'new',
      contentBlocks: [{ type: 'context_attachment', attachment: quote }],
    });
  expect(writes()).toEqual([
    ['PUT', '/api/threads/t1/composer-draft', body(0)],
    ['PUT', '/api/threads/t1/composer-draft', body(5)],
  ]);
});

it('writes an edit still waiting at once when the owner moves to another conversation', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_path, init) =>
    init?.method ? Response.json({ draft: { revision: 1 } }) : Response.json({ draft: null, revision: 0 }),
  );
  const { hook, state } = mount({ text: '', images: [], contexts: [] });
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
  state.draft = { text: 'half a thought', images: [], contexts: [] };
  hook.rerender();
  await flushed();
  state.threadId = 't2';
  state.draft = { text: '', images: [], contexts: [] };
  hook.rerender();
  await flushed(100);
  expect(writes()).toEqual([
    ['PUT', '/api/threads/t1/composer-draft', JSON.stringify({ expectedRevision: 0, text: 'half a thought' })],
  ]);
});

it('deletes the saved draft of a conversation whose send the server took', async () => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ draft: { text: 'sent soon' }, revision: 2 }));
  const { hook } = mount({ text: 'sent soon', images: [], contexts: [] });
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  await settle(50);
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ draft: null, revision: 3 }));
  hook.result.current.clear('t1');
  await waitFor(() =>
    expect(writes()).toContainEqual([
      'DELETE',
      '/api/threads/t1/composer-draft',
      JSON.stringify({ expectedRevision: 2 }),
    ]),
  );
});

it('puts back the images and files of a saved draft, writes nothing while they are read, and keeps them with their details in later writes', async () => {
  let readBack: (files: unknown) => void = () => {};
  vi.mocked(apiFetch).mockImplementation(async (_path, init) =>
    init?.method === 'PUT'
      ? Response.json({ draft: { revision: 8 } })
      : Response.json({
          draft: {
            text: 'see this',
            contentBlocks: [
              { type: 'image', url: '/uploads/a.png' },
              {
                type: 'file',
                url: '/uploads/notes.pdf',
                fileName: 'notes.pdf',
                mimeType: 'application/pdf',
                fileSize: 12,
              },
            ],
          },
          revision: 7,
        }),
  );
  const state = { draft: { text: '', images: [], contexts: [] } as ComposerDraft };
  const host: { rerender?: () => void } = {};
  const restore = vi.fn((saved: ComposerDraft) => {
    // The input shows the words at once; the images arrive once they are read back.
    state.draft = { ...saved, images: [] };
    host.rerender?.();
    return new Promise((resolve) => {
      readBack = () => {
        state.draft = saved;
        host.rerender?.();
        resolve(undefined);
      };
    });
  });
  const hook = renderHook(() => useServerComposerDraft({ threadId: 't1', enabled: true, draft: state.draft, restore }));
  host.rerender = hook.rerender;
  await waitFor(() =>
    expect(restore).toHaveBeenCalledWith(
      {
        text: 'see this',
        images: [
          { type: 'image', url: '/uploads/a.png' },
          { type: 'file', url: '/uploads/notes.pdf', fileName: 'notes.pdf', mimeType: 'application/pdf', fileSize: 12 },
        ],
        contexts: [],
      },
      expect.any(Function),
    ),
  );
  await flushed(700);
  expect(writes()).toEqual([]);
  readBack(null);
  await flushed(700);
  expect(writes()).toEqual([]);
  state.draft = { ...state.draft, text: 'see this one' };
  hook.rerender();
  await flushed(700);
  expect(writes()).toEqual([
    [
      'PUT',
      '/api/threads/t1/composer-draft',
      JSON.stringify({
        expectedRevision: 7,
        text: 'see this one',
        contentBlocks: [
          { type: 'image', url: '/uploads/a.png' },
          { type: 'file', url: '/uploads/notes.pdf', fileName: 'notes.pdf', mimeType: 'application/pdf', fileSize: 12 },
        ],
      }),
    ],
  ]);
});

it('leaves a saved draft whose images cannot be read back as the server keeps it', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    Response.json({
      draft: { text: 'see this', contentBlocks: [{ type: 'image', url: '/uploads/a.png' }] },
      revision: 7,
    }),
  );
  const state = { draft: { text: '', images: [], contexts: [] } as ComposerDraft };
  const host: { rerender?: () => void } = {};
  const restore = vi.fn((saved: ComposerDraft) => {
    state.draft = { ...saved, images: [] };
    host.rerender?.();
    return Promise.reject(new Error('image unreadable'));
  });
  const hook = renderHook(() => useServerComposerDraft({ threadId: 't1', enabled: true, draft: state.draft, restore }));
  host.rerender = hook.rerender;
  await waitFor(() => expect(restore).toHaveBeenCalled());
  state.draft = { ...state.draft, text: 'see this one' };
  hook.rerender();
  await flushed(700);
  expect(writes()).toEqual([]);
});

it('keeps images read back for one conversation out of the conversation opened meanwhile', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    init?.method === 'PUT'
      ? Response.json({ draft: { revision: 9 } })
      : String(path).includes('/t1/')
        ? Response.json({
            draft: { text: 'A', contentBlocks: [{ type: 'image', url: '/uploads/a.png' }] },
            revision: 1,
          })
        : Response.json({ draft: { text: 'B' }, revision: 2 }),
  );
  const state = { draft: { text: '', images: [], contexts: [] } as ComposerDraft, threadId: 't1' };
  const host: { rerender?: () => void } = {};
  let readBack: () => void = () => {};
  const restore = vi.fn((saved: ComposerDraft, current: () => boolean) => {
    // Like the host: words at once, images once they are read back, and only into the conversation that asked.
    state.draft = { ...saved, images: [] };
    host.rerender?.();
    return new Promise<void>((resolve) => {
      const done = () => {
        if (current()) {
          state.draft = { ...state.draft, images: saved.images };
          host.rerender?.();
        }
        resolve();
      };
      if (saved.images.length) readBack = done;
      else done();
    });
  });
  const hook = renderHook(() =>
    useServerComposerDraft({ threadId: state.threadId, enabled: true, draft: state.draft, restore }),
  );
  host.rerender = hook.rerender;
  await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
  state.threadId = 't2';
  hook.rerender();
  await waitFor(() => expect(restore).toHaveBeenCalledTimes(2));
  await flushed();
  readBack();
  await flushed(700);
  expect(state.draft).toEqual({ text: 'B', images: [], contexts: [] });
  expect(writes().filter(([, path, body]) => String(path).includes('/t2/') && String(body).includes('a.png'))).toEqual(
    [],
  );
});

it('leaves a saved image draft as it is when the owner leaves and comes back while its images are still being read', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    init?.method === 'PUT'
      ? Response.json({ draft: { revision: 9 } })
      : String(path).includes('/t1/')
        ? Response.json({
            draft: { text: 'A', contentBlocks: [{ type: 'image', url: '/uploads/a.png' }] },
            revision: 1,
          })
        : Response.json({ draft: { text: 'B' }, revision: 2 }),
  );
  const state = { draft: { text: '', images: [], contexts: [] } as ComposerDraft, threadId: 't1' };
  const host: { rerender?: () => void } = {};
  // Like the host: words at once; the images of A are never read back during this test.
  const restore = vi.fn((saved: ComposerDraft) => {
    state.draft = { ...saved, images: [] };
    host.rerender?.();
    return saved.images.length ? new Promise<void>(() => {}) : undefined;
  });
  const hook = renderHook(() =>
    useServerComposerDraft({ threadId: state.threadId, enabled: true, draft: state.draft, restore }),
  );
  host.rerender = hook.rerender;
  await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
  state.threadId = 't2';
  hook.rerender();
  await waitFor(() => expect(restore).toHaveBeenCalledTimes(2));
  // Back to A: the input shows A's words again, its images not yet.
  state.threadId = 't1';
  state.draft = { text: 'A', images: [], contexts: [] };
  hook.rerender();
  await waitFor(() => expect(restore).toHaveBeenCalledTimes(3));
  await flushed(700);
  expect(writes().filter(([, path]) => String(path).includes('/t1/'))).toEqual([]);
});

it('keeps saving a newer opening when the image read of an older opening of the same conversation fails late', async () => {
  let aReads = 0;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'PUT') return Response.json({ draft: { revision: 9 } });
    if (!String(path).includes('/t1/')) return Response.json({ draft: { text: 'B' }, revision: 2 });
    aReads += 1;
    // Another tab replaced A's image between the two openings.
    return aReads === 1
      ? Response.json({
          draft: { text: 'A', contentBlocks: [{ type: 'image', url: '/uploads/old.png' }] },
          revision: 1,
        })
      : Response.json({
          draft: { text: 'A', contentBlocks: [{ type: 'image', url: '/uploads/new.png' }] },
          revision: 3,
        });
  });
  const state = { draft: { text: '', images: [], contexts: [] } as ComposerDraft, threadId: 't1' };
  const host: { rerender?: () => void } = {};
  let failOld: () => void = () => {};
  const restore = vi.fn((saved: ComposerDraft) => {
    state.draft = { ...saved, images: [] };
    host.rerender?.();
    if (!saved.images.length) return undefined;
    if (saved.images[0].url === '/uploads/old.png')
      return new Promise<void>((_, reject) => {
        failOld = () => reject(new Error('503'));
      });
    state.draft = saved;
    host.rerender?.();
    return Promise.resolve();
  });
  const hook = renderHook(() =>
    useServerComposerDraft({ threadId: state.threadId, enabled: true, draft: state.draft, restore }),
  );
  host.rerender = hook.rerender;
  await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
  state.threadId = 't2';
  hook.rerender();
  await waitFor(() => expect(restore).toHaveBeenCalledTimes(2));
  state.threadId = 't1';
  state.draft = { text: 'A', images: [], contexts: [] };
  hook.rerender();
  await waitFor(() => expect(restore).toHaveBeenCalledTimes(3));
  await flushed();
  failOld();
  await flushed();
  state.draft = { ...state.draft, text: 'A, continued' };
  hook.rerender();
  await flushed(700);
  const toA = writes().filter(([, path]) => String(path).includes('/t1/'));
  expect(toA).toHaveLength(1);
  expect(JSON.parse(String(toA[0][2]))).toMatchObject({
    expectedRevision: 3,
    text: 'A, continued',
    contentBlocks: [{ type: 'image', url: '/uploads/new.png' }],
  });
});
