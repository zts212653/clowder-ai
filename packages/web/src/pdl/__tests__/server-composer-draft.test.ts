import type { ContextAttachment } from '@cat-cafe/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { apiSessionIdentity, observeApiSessionOwner } from '@/utils/api-session-identity';
import { type ComposerDraft, useServerComposerDraft } from '../useServerComposerDraft';
import { cleanup, renderHook, waitFor } from './hook-host';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  observeApiSessionOwner('composer-test-owner');
});
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
  const state = { draft, threadId, holdWrites: false, revision: 0 };
  const host: { rerender?: () => void } = {};
  const restore = vi.fn((saved: ComposerDraft) => {
    state.draft = saved;
    host.rerender?.();
  });
  const hook = renderHook(() =>
    useServerComposerDraft({
      threadId: state.threadId,
      enabled: true,
      draft: state.draft,
      restore,
      holdWrites: state.holdWrites,
      revision: state.revision,
    }),
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

const fileA = { type: 'file', url: '/uploads/a.txt', fileName: 'a.txt', mimeType: 'text/plain', fileSize: 1 } as const;
const fileB = { type: 'file', url: '/uploads/b.txt', fileName: 'b.txt', mimeType: 'text/plain', fileSize: 2 } as const;

/** A tab that read revision 4 (text + file A) while another tab saved revision 5 with file B added. */
function conflicting(server5: { text: string; contentBlocks: unknown[] }) {
  let reads = 0;
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
    if (!init?.method)
      return reads++ === 0
        ? Response.json({ draft: { text: 'base', contentBlocks: [fileA] }, revision: 4 })
        : Response.json({ draft: server5, revision: 5 });
    const body = JSON.parse(String(init.body)) as { expectedRevision: number };
    return body.expectedRevision === 5
      ? Response.json({ draft: { revision: 6 } })
      : Response.json({ code: 'DRAFT_REVISION_MISMATCH', actualRevision: 5 }, { status: 409 });
  });
}

it('on a revision conflict reads the draft again, keeps what the other tab added and writes the edit of this tab over it', async () => {
  conflicting({ text: 'base', contentBlocks: [fileA, fileB] });
  const { hook, restore, state } = mount({ text: '', images: [], contexts: [] });
  await waitFor(() => expect(state.draft).toEqual({ text: 'base', images: [fileA], contexts: [] }));
  state.draft = { ...state.draft, text: 'base edited' };
  hook.rerender();
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writes()).toEqual([
    [
      'PUT',
      '/api/threads/t1/composer-draft',
      JSON.stringify({ expectedRevision: 4, text: 'base edited', contentBlocks: [fileA] }),
    ],
    [
      'PUT',
      '/api/threads/t1/composer-draft',
      JSON.stringify({ expectedRevision: 5, text: 'base edited', contentBlocks: [fileA, fileB] }),
    ],
  ]);
  // The input shows the file the other tab added.
  expect(restore).toHaveBeenLastCalledWith(
    { text: 'base edited', images: [fileA, fileB], contexts: [] },
    expect.any(Function),
  );
});

it('on a revision conflict a file this tab removed stays removed', async () => {
  conflicting({ text: 'base', contentBlocks: [fileA, fileB] });
  const { hook, state } = mount({ text: '', images: [], contexts: [] });
  await waitFor(() => expect(state.draft.images).toEqual([fileA]));
  state.draft = { ...state.draft, images: [] };
  hook.rerender();
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writes()[1]).toEqual([
    'PUT',
    '/api/threads/t1/composer-draft',
    JSON.stringify({ expectedRevision: 5, text: 'base', contentBlocks: [fileB] }),
  ]);
});

it('words typed before the server answered keep the attachments the server holds, shown and written together', async () => {
  let answer: (r: Response) => void = () => {};
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
  answer(
    Response.json({
      draft: { text: 'older', contentBlocks: [{ type: 'image', url: '/uploads/i.png' }, fileA] },
      revision: 2,
    }),
  );
  const merged = { text: 'typed first', images: [{ type: 'image', url: '/uploads/i.png' }, fileA], contexts: [] };
  await waitFor(() => expect(restore).toHaveBeenCalledWith(merged, expect.any(Function)));
  await waitFor(() =>
    expect(writes()).toEqual([
      [
        'PUT',
        '/api/threads/t1/composer-draft',
        JSON.stringify({ expectedRevision: 2, text: 'typed first', contentBlocks: merged.images }),
      ],
    ]),
  );
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

it('uses the known draft revision at admission and adopts the consume receipt', async () => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ draft: { text: 'sent soon' }, revision: 2 }));
  const { hook, state } = mount({ text: '', images: [], contexts: [] });
  await waitFor(() => expect(state.draft.text).toBe('sent soon'));
  const admit = vi.fn(async () => ({ revision: 3 }));
  expect(await hook.result.current.send('t1', admit)).toBe(true);
  expect(admit).toHaveBeenCalledWith(2, expect.any(AbortSignal));
  expect(writes()).toEqual([]);
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

it('edits made while an earlier write is still resolving its conflict are written after it, over the revision it left', async () => {
  let reads = 0;
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
    if (!init?.method)
      return reads++ === 0
        ? Response.json({ draft: { text: 'base', contentBlocks: [fileA] }, revision: 4 })
        : Response.json({ draft: { text: 'base', contentBlocks: [fileA, fileB] }, revision: 5 });
    const body = JSON.parse(String(init.body)) as { expectedRevision: number };
    if (body.expectedRevision === 4) {
      await settle(1200);
      return Response.json({ code: 'DRAFT_REVISION_MISMATCH', actualRevision: 5 }, { status: 409 });
    }
    return body.expectedRevision === 5
      ? Response.json({ draft: { revision: 6 } })
      : Response.json({ draft: { revision: body.expectedRevision + 1 } });
  });
  const { hook, state } = mount({ text: '', images: [], contexts: [] });
  await waitFor(() => expect(state.draft.images).toEqual([fileA]));
  state.draft = { ...state.draft, text: 'A' };
  hook.rerender();
  await flushed(700);
  // B: more words, and file A removed, while A's write is still waiting on the server.
  state.draft = { ...state.draft, text: 'B', images: [] };
  hook.rerender();
  await flushed(3000);
  expect(writes().map(([, , body]) => JSON.parse(String(body)))).toEqual([
    { expectedRevision: 4, text: 'A', contentBlocks: [fileA] },
    { expectedRevision: 5, text: 'A', contentBlocks: [fileA, fileB] },
    { expectedRevision: 6, text: 'B', contentBlocks: [fileB] },
  ]);
});

it('keeps IME composition out of the server draft and writes the committed text after release', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_path, init) =>
    init?.method ? Response.json({ draft: { revision: 2 } }) : Response.json({ draft: { text: 'saved' }, revision: 1 }),
  );
  const { hook, state } = mount({ text: 'saved', images: [], contexts: [] });
  await flushed();
  state.draft = { text: 'saved你', images: [], contexts: [] };
  state.revision = 1;
  state.holdWrites = true;
  hook.rerender();
  await flushed(700);
  expect(writes()).toEqual([]);

  state.holdWrites = false;
  hook.rerender();
  await flushed(700);
  expect(writes()).toEqual([
    ['PUT', '/api/threads/t1/composer-draft', JSON.stringify({ expectedRevision: 1, text: 'saved你' })],
  ]);
});

it('does not let a late draft read replace text edited during composition', async () => {
  let answer: (response: Response) => void = () => {};
  vi.mocked(apiFetch).mockImplementation((_path, init) =>
    init?.method
      ? Promise.resolve(Response.json({ draft: { revision: 2 } }))
      : new Promise<Response>((resolve) => {
          answer = resolve;
        }),
  );
  const { hook, restore, state } = mount({ text: '', images: [], contexts: [] });
  state.draft = { text: 'Ani', images: [], contexts: [] };
  state.revision = 1;
  state.holdWrites = true;
  hook.rerender();
  await flushed();
  answer(Response.json({ draft: { text: 'A' }, revision: 1 }));
  await flushed();
  expect(restore).not.toHaveBeenCalled();
  expect(writes()).toEqual([]);

  state.draft = { text: 'A你', images: [], contexts: [] };
  state.holdWrites = false;
  hook.rerender();
  await flushed(700);
  expect(writes()).toEqual([
    ['PUT', '/api/threads/t1/composer-draft', JSON.stringify({ expectedRevision: 1, text: 'A你' })],
  ]);
});

it('saves text committed during attachment restoration with the restored attachment', async () => {
  const attachment = { type: 'image', url: '/uploads/a.png' } as const;
  const read = Promise.withResolvers<Response>();
  vi.mocked(apiFetch).mockImplementation(async (_path, init) =>
    init?.method ? Response.json({ draft: { revision: 2 } }) : read.promise,
  );
  const loaded = Promise.withResolvers<void>();
  const { hook, restore, state } = mount({ text: '', images: [], contexts: [] });
  restore.mockImplementation((saved) => {
    state.draft = { ...saved, images: [] };
    hook.rerender();
    return loaded.promise.then(() => {
      state.draft = { ...state.draft, images: saved.images };
      hook.rerender();
    });
  });
  state.draft = { ...state.draft, text: 'A' };
  state.revision += 1;
  hook.rerender();
  await flushed();
  read.resolve(Response.json({ draft: { text: 'old', contentBlocks: [attachment] }, revision: 1 }));
  await waitFor(() => expect(restore).toHaveBeenCalled());
  expect(state.draft.text).toBe('A');

  state.draft = { ...state.draft, text: 'Ani' };
  state.holdWrites = true;
  state.revision += 1;
  hook.rerender();
  await flushed();
  state.draft = { ...state.draft, text: 'A你好' };
  state.holdWrites = false;
  state.revision += 1;
  hook.rerender();
  await flushed();
  expect(writes()).toEqual([]);

  loaded.resolve();
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()).toEqual([
    [
      'PUT',
      '/api/threads/t1/composer-draft',
      JSON.stringify({ expectedRevision: 1, text: 'A你好', contentBlocks: [attachment] }),
    ],
  ]);
});

it('flushes only the last committed draft when leaving during a composition', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    String(path).includes('/t2/')
      ? Response.json({ draft: null, revision: 2 })
      : Response.json({ draft: { text: 'saved' }, revision: 1 }),
  );
  const { hook, state } = mount({ text: 'saved', images: [], contexts: [] });
  await flushed();
  state.draft = { text: 'committed', images: [], contexts: [] };
  state.revision = 1;
  hook.rerender();
  await flushed();
  state.draft = { text: 'committedni', images: [], contexts: [] };
  state.revision = 2;
  state.holdWrites = true;
  hook.rerender();
  await flushed(300);
  state.threadId = 't2';
  hook.rerender();
  await flushed(700);
  expect(writes()).toEqual([
    ['PUT', '/api/threads/t1/composer-draft', JSON.stringify({ expectedRevision: 1, text: 'committed' })],
  ]);
});

it('persists the owner attachment and reply edits made during a slow draft restore', async () => {
  const loaded = Promise.withResolvers<void>();
  const nextQuote = { ...quote, id: 'new-quote' };
  const read = Promise.withResolvers<Response>();
  vi.mocked(apiFetch).mockImplementation(async (_path, init) =>
    init?.method ? Response.json({ draft: { revision: 2 } }) : read.promise,
  );
  const { hook, restore, state } = mount({ text: '', images: [], contexts: [] });
  restore.mockImplementation((saved) => {
    state.draft = { ...saved, images: [] };
    hook.rerender();
    return loaded.promise.then(() => {
      state.draft = { ...state.draft, images: [...saved.images, ...state.draft.images] };
      hook.rerender();
    });
  });
  state.draft = { ...state.draft, text: 'typed' };
  hook.rerender();
  await flushed();
  read.resolve(
    Response.json({
      draft: {
        text: 'saved',
        replyTo: 'before',
        contentBlocks: [fileA, { type: 'context_attachment', attachment: quote }],
      },
      revision: 1,
    }),
  );
  await waitFor(() => expect(restore).toHaveBeenCalledOnce());
  state.draft = { text: 'typed', images: [fileB], contexts: [nextQuote], replyTo: 'after' };
  hook.rerender();
  await flushed();
  expect(writes()).toEqual([]);

  loaded.resolve();
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(JSON.parse(String(writes()[0]?.[2]))).toMatchObject({
    expectedRevision: 1,
    replyTo: 'after',
    contentBlocks: [fileA, fileB, { type: 'context_attachment', attachment: nextQuote }],
  });
});

it('keeps edits and unopened attachments when leaving during restore and reopening before the write returns', async () => {
  const loadFirst = Promise.withResolvers<void>();
  const acceptEdit = Promise.withResolvers<void>();
  let serverDraft = { text: 'old text', contentBlocks: [fileA], revision: 1 };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (!String(path).includes('/t1/')) return Response.json({ draft: null, revision: 0 });
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as typeof serverDraft;
      await acceptEdit.promise;
      serverDraft = { text: body.text, contentBlocks: body.contentBlocks, revision: 2 };
      return Response.json({ draft: serverDraft });
    }
    return Response.json({ draft: serverDraft, revision: serverDraft.revision });
  });

  const empty = { text: '', images: [], contexts: [] };
  const { hook, restore, state } = mount(empty);
  let restorations = 0;
  restore.mockImplementation((saved) => {
    restorations += 1;
    state.draft = restorations === 1 ? { ...saved, images: [] } : saved;
    hook.rerender();
    return restorations === 1 ? loadFirst.promise : undefined;
  });
  await waitFor(() => expect(state.draft.text).toBe('old text'));
  state.draft = { ...state.draft, text: 'new user words' };
  hook.rerender();
  await flushed();
  expect(writes()).toEqual([]);

  state.threadId = 't2';
  state.draft = empty;
  hook.rerender();
  await flushed();
  state.threadId = 't1';
  state.draft = { ...empty, text: 'new user words' };
  hook.rerender();
  await flushed();
  expect(state.draft.text).toBe('new user words');
  expect(writes()).toHaveLength(1);
  expect(JSON.parse(String(writes()[0][2]))).toMatchObject({
    expectedRevision: 1,
    text: 'new user words',
    contentBlocks: [fileA],
  });
  acceptEdit.resolve();
  await waitFor(() => expect(state.draft.images).toEqual([fileA]));
  loadFirst.resolve();
  await flushed();
  expect(state.draft.text).toBe('new user words');
});

it('keeps only new edits when another device cleared a draft during an interrupted restore', async () => {
  let clearedElsewhere = false;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (!String(path).includes('/t1/')) return Response.json({ draft: null, revision: 0 });
    if (init?.method === 'PUT') {
      if (!clearedElsewhere) {
        clearedElsewhere = true;
        return Response.json({ code: 'DRAFT_REVISION_MISMATCH', actualRevision: 2 }, { status: 409 });
      }
      return Response.json({ draft: { revision: 3 } });
    }
    return clearedElsewhere
      ? Response.json({ draft: null, revision: 2 })
      : Response.json({ draft: { text: 'old text', replyTo: 'old reply', contentBlocks: [fileA] }, revision: 1 });
  });

  const empty = { text: '', images: [], contexts: [] };
  const { hook, restore, state } = mount(empty);
  const download = Promise.withResolvers<void>();
  restore.mockImplementation((saved) => {
    state.draft = { ...saved, images: [] };
    hook.rerender();
    return saved.images.length ? download.promise : undefined;
  });
  await waitFor(() => expect(state.draft.text).toBe('old text'));
  state.draft = { ...state.draft, contexts: [quote] };
  hook.rerender();
  await flushed();
  state.threadId = 't2';
  state.draft = empty;
  hook.rerender();
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(JSON.parse(String(writes()[1][2]))).toEqual({
    expectedRevision: 2,
    text: '',
    contentBlocks: [{ type: 'context_attachment', attachment: quote }],
  });
  download.resolve();
});

it('cancels slow restoration when the current conversation sends, keeping the next draft clean', async () => {
  const files = Promise.withResolvers<void>();
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
    if (init?.method === 'DELETE') return Response.json({ draft: null, revision: 2 });
    if (init?.method === 'PUT') return Response.json({ draft: { revision: 3 } });
    return Response.json({ draft: { text: 'sent', contentBlocks: [fileA] }, revision: 1 });
  });
  const { hook, restore, state } = mount({ text: '', images: [], contexts: [] });
  restore.mockImplementation((saved, current?: () => boolean) => {
    state.draft = { ...saved, images: [] };
    hook.rerender();
    return files.promise.then(() => {
      if (current?.()) {
        state.draft = { ...state.draft, images: saved.images };
        hook.rerender();
      }
    });
  });
  await waitFor(() => expect(state.draft.text).toBe('sent'));

  const admitted = vi.fn(async () => ({ revision: 2 }));
  expect(await hook.result.current.send('t1', admitted)).toBe(true);
  expect(admitted).toHaveBeenCalledWith(1, expect.any(AbortSignal));
  state.draft = { text: 'next message', images: [], contexts: [] };
  hook.rerender();
  files.resolve();
  await waitFor(() => expect(writes().some(([method]) => method === 'PUT')).toBe(true));
  expect(state.draft).toEqual({ text: 'next message', images: [], contexts: [] });
  expect(writes().map(([method]) => method)).toEqual(['PUT']);
  expect(JSON.parse(String(writes()[0][2]))).toEqual({ expectedRevision: 2, text: 'next message' });
});

it('keeps a failed departure write when the conversation reopens against the older saved draft', async () => {
  const firstRestore = Promise.withResolvers<void>();
  let attempts = 0;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (!String(path).includes('/t1/')) return Response.json({ draft: null, revision: 0 });
    if (init?.method === 'PUT') {
      return ++attempts === 1
        ? Response.json({ error: 'temporarily unavailable' }, { status: 503 })
        : Response.json({ draft: { revision: 2 } });
    }
    return Response.json({ draft: { text: 'old words', contentBlocks: [fileA] }, revision: 1 });
  });

  const empty = { text: '', images: [], contexts: [] };
  const { hook, restore, state } = mount(empty);
  let restores = 0;
  restore.mockImplementation((saved) => {
    state.draft = ++restores === 1 ? { ...saved, images: [] } : saved;
    hook.rerender();
    return restores === 1 ? firstRestore.promise : undefined;
  });
  await waitFor(() => expect(state.draft.text).toBe('old words'));
  state.draft = { ...state.draft, text: 'keep my new work' };
  hook.rerender();
  await flushed();

  state.threadId = 't2';
  state.draft = empty;
  hook.rerender();
  await waitFor(() => expect(attempts).toBe(1));
  state.threadId = 't1';
  state.draft = { ...empty, text: 'keep my new work' };
  hook.rerender();
  await waitFor(() => expect(state.draft.images).toEqual([fileA]));
  expect(state.draft.text).toBe('keep my new work');
  await waitFor(() => expect(attempts).toBe(2));
  expect(writes().map(([, , body]) => JSON.parse(String(body)).text)).toEqual(['keep my new work', 'keep my new work']);
  firstRestore.resolve();
});

it('replays a failed committed edit over the latest saved draft after the page remounts', async () => {
  let writesSeen = 0;
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
    if (init?.method === 'PUT') {
      writesSeen += 1;
      return writesSeen === 1 ? new Response(null, { status: 503 }) : Response.json({ draft: { revision: 3 } });
    }
    return Response.json({
      draft: { text: 'older words', contentBlocks: writesSeen ? [fileA, fileB] : [fileA] },
      revision: writesSeen ? 2 : 1,
    });
  });
  const first = mount({ text: '', images: [], contexts: [] });
  await waitFor(() => expect(first.state.draft.images).toEqual([fileA]));
  first.state.draft = { ...first.state.draft, text: 'durable edit' };
  first.hook.rerender();
  await waitFor(() => expect(writesSeen).toBe(1));
  await cleanup();

  const again = mount({ text: 'durable edit', images: [], contexts: [] });
  await waitFor(() => expect(again.state.draft.images).toEqual([fileA, fileB]));
  expect(again.state.draft.text).toBe('durable edit');
  await waitFor(() => expect(writesSeen).toBe(2));
  expect(JSON.parse(String(writes()[1][2])).text).toBe('durable edit');
});

it('keeps failed edits under the authenticated owner when another account opens the same conversation', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (!String(path).includes('/t1/')) return Response.json({ draft: null, revision: 0 });
    if (init?.method === 'PUT') return new Response(null, { status: 503 });
    const owner = apiSessionIdentity.getSnapshot().ownerUserId;
    return Response.json({ draft: { text: owner === 'alice' ? 'first saved' : 'second saved' }, revision: 7 });
  });
  observeApiSessionOwner('alice');
  const { hook, state } = mount({ text: '', images: [], contexts: [] });
  await waitFor(() => expect(state.draft.text).toBe('first saved'));
  state.draft = { ...state.draft, text: 'first unfinished' };
  hook.rerender();
  await waitFor(() => expect(writes()).toHaveLength(1));
  state.threadId = 't2';
  state.draft = { text: '', images: [], contexts: [] };
  hook.rerender();
  await flushed();
  observeApiSessionOwner('bob');
  state.threadId = 't1';
  hook.rerender();
  await waitFor(() => expect(state.draft.text).not.toBe(''));
  expect(state.draft.text).toBe('second saved');
  await flushed(650);
  expect(writes()).toHaveLength(1);
});

it('keeps a late first read behind a send that already consumed its revision', async () => {
  const opening = Promise.withResolvers<Response>();
  vi.mocked(apiFetch).mockImplementation(async (_path, init) =>
    init?.method === 'PUT' ? Response.json({ draft: { revision: 3 } }) : opening.promise,
  );
  const empty = { text: '', images: [], contexts: [] };
  const { hook, restore, state } = mount(empty);
  const admitted = vi.fn(async () => ({ revision: 2 }));
  expect(await hook.result.current.send('t1', admitted)).toBe(true);
  expect(admitted).toHaveBeenCalledWith('current', expect.any(AbortSignal));

  state.draft = { ...empty, text: 'after send' };
  hook.rerender();
  opening.resolve(Response.json({ draft: { text: 'before send', contentBlocks: [fileA] }, revision: 1 }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(restore).not.toHaveBeenCalled();
  expect(JSON.parse(String(writes()[0][2]))).toEqual({ expectedRevision: 2, text: 'after send' });
});
