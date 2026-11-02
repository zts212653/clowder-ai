import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileBlock } from '../FileBlock';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  dispatch: vi.fn(),
  panel: vi.fn(),
  visible: vi.fn(),
  publication: vi.fn(() => true),
  thread: 'thread-source',
}));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://localhost:3102', apiFetch: mocks.fetch }));
vi.mock('@/stores/chatStore', () => {
  const getState = () => ({
    currentThreadId: mocks.thread,
    openPublishedArtifact: mocks.dispatch,
    setRightPanelMode: mocks.panel,
    setRightPanelOpen: mocks.visible,
    openPublication: mocks.publication,
  });
  return {
    useChatStore: Object.assign((selector: (state: ReturnType<typeof getState>) => unknown) => selector(getState()), {
      getState,
    }),
  };
});
vi.mock('@/components/workbench/experience-workbench-store', () => ({
  useF307ExperienceWorkbenchStore: { getState: () => ({ dispatch: mocks.dispatch }) },
}));

const artifact = {
  type: 'file' as const,
  name: '工作日历.md',
  url: '/uploads/calendar.md',
  sourceMessageId: 'message-source',
  createdAt: 700,
  catId: 'codex-astra',
};
const block = {
  kind: 'file' as const,
  v: 1 as const,
  id: 'file-calendar',
  fileName: artifact.name,
  url: artifact.url,
  mimeType: 'text/markdown',
};

describe('published file opens in the existing Artifact surface', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    mocks.thread = 'thread-source';
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ artifacts: [artifact] }) });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });
  async function render() {
    await act(async () =>
      root.render(<FileBlock block={block} messageId="message-source" sourceThreadId="thread-source" />),
    );
  }

  it('offers Open separately from Download and uses the canonical publication identity', async () => {
    await render();
    const open = container.querySelector<HTMLButtonElement>('[data-testid="chat-work-open"]');
    expect(open).not.toBeNull();
    await act(async () => open?.click());
    expect(mocks.fetch).toHaveBeenCalledWith('/api/threads/thread-source/artifacts', expect.any(Object));
    expect(mocks.dispatch).toHaveBeenCalledWith(
      'thread-source',
      artifact,
      expect.objectContaining({ messageId: expect.any(String) }),
    );
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.click());
    expect(container.querySelector('a[download]')?.getAttribute('href')).toBe(`http://localhost:3102${artifact.url}`);
  });

  it('does not guess by filename or URL when the publication belongs to another message', async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ artifacts: [{ ...artifact, sourceMessageId: 'different-message' }] }),
    });
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-work-open"]')?.click());
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('uses original message lineage when the visible bubble combines multiple messages', async () => {
    await act(async () =>
      root.render(
        <FileBlock
          block={block}
          messageId="combined-bubble"
          sourceThreadId="thread-source"
          sourceMessageIds={['message-source', 'other-source']}
        />,
      ),
    );
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-work-open"]')?.click());
    expect(mocks.dispatch).toHaveBeenCalledWith(
      'thread-source',
      artifact,
      expect.objectContaining({ messageId: expect.any(String) }),
    );
  });

  it('does not navigate a different thread after a delayed catalog response', async () => {
    let finish: (result: unknown) => void = () => {};
    mocks.fetch.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-work-open"]')?.click());
    mocks.thread = 'thread-elsewhere';
    await act(async () => finish({ ok: true, json: async () => ({ artifacts: [artifact] }) }));
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('does not open a retained work after the same file card changes its source while authorization is pending', async () => {
    const work = { contentRef: `work:${'a'.repeat(64)}`, ownerRevision: 1, currentOwnerRevision: 1 };
    const pendingReads: Array<() => void> = [];
    const registered = { ...artifact, type: 'video', work };
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/works/resolve-file')) return { ok: true, json: async () => ({ artifact: registered }) };
      return new Promise((resolve) =>
        pendingReads.push(() =>
          resolve({
            ok: true,
            json: async () => ({
              asset: { ...work, mediaType: 'video/mp4', blobDigest: `sha256:${'b'.repeat(64)}` },
              currentOwnerRevision: 1,
            }),
          }),
        ),
      );
    });
    await act(async () =>
      root.render(
        <FileBlock
          block={{
            ...block,
            fileName: 'original.mp4',
            url: `/api/content-publications/${encodeURIComponent(work.contentRef)}/media/1`,
          }}
          messageId="message-source"
          sourceThreadId="thread-source"
        />,
      ),
    );
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-work-open"]')?.click());
    expect(pendingReads.length).toBeGreaterThan(0);
    await render();
    await act(async () => {
      for (const finish of pendingReads) finish();
    });
    expect(mocks.publication).not.toHaveBeenCalled();
  });

  it('uses the registered title and exact owner ledger for a source-proven video file, and blocks a failed recheck', async () => {
    const work = { contentRef: `work:${'a'.repeat(64)}`, ownerRevision: 1, currentOwnerRevision: 3 };
    const registered = {
      ...artifact,
      type: 'video',
      name: '已登记作品的标题',
      work,
      url: `/api/content-publications/${encodeURIComponent(work.contentRef)}/media/1`,
    };
    mocks.fetch.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () =>
        url.startsWith('/api/works/resolve-file')
          ? { artifact: registered }
          : {
              asset: {
                contentRef: work.contentRef,
                ownerRevision: 1,
                mediaType: 'video/mp4',
                blobDigest: `sha256:${'b'.repeat(64)}`,
              },
              currentOwnerRevision: 3,
            },
    }));
    await act(async () =>
      root.render(
        <FileBlock
          block={{
            ...block,
            fileName: 'file.mp4',
            mimeType: 'video/mp4',
            url: '/api/workspace/file/raw?worktreeId=work&path=file.mp4',
          }}
          messageId="message-source"
          sourceThreadId="thread-source"
        />,
      ),
    );
    expect(container.textContent).toContain(registered.name);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-work-open"]')?.click());
    expect(mocks.publication).toHaveBeenCalledWith(
      expect.objectContaining({ contentRef: work.contentRef, ownerRevision: 1, title: registered.name }),
      'thread-source',
      'work-mode',
    );
    expect(mocks.dispatch).not.toHaveBeenCalled();
    mocks.publication.mockClear();
    mocks.fetch.mockResolvedValueOnce({ ok: false, status: 403 });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-work-open"]')?.click());
    expect(mocks.publication).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('waits for work resolution before admitting any raw-file video request', async () => {
    let finish: (value: unknown) => void = () => {};
    mocks.fetch.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const create = vi.spyOn(document, 'createElement');
    try {
      await act(async () =>
        root.render(
          <FileBlock
            block={{
              ...block,
              fileName: 'pending.mp4',
              mimeType: 'video/mp4',
              url: '/api/workspace/file/raw?worktreeId=work&path=pending.mp4',
            }}
            messageId="message-source"
            sourceThreadId="thread-source"
          />,
        ),
      );
      expect(mocks.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/works/resolve-file?'), expect.any(Object));
      expect(create.mock.calls.filter(([tag]) => tag === 'video')).toHaveLength(0);
      await act(async () => finish({ ok: true, json: async () => ({ artifact: null }) }));
      const request = create.mock.calls.findIndex(([tag]) => tag === 'video');
      const reader = create.mock.results[request]?.value as HTMLVideoElement | undefined;
      expect(reader?.getAttribute('src')).toBe(
        'http://localhost:3102/api/workspace/file/raw?worktreeId=work&path=pending.mp4',
      );
    } finally {
      create.mockRestore();
    }
  });
});
