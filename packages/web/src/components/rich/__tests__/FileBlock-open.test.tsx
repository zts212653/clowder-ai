import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileBlock } from '../FileBlock';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  dispatch: vi.fn(),
  panel: vi.fn(),
  visible: vi.fn(),
  thread: 'thread-source',
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.fetch }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      currentThreadId: mocks.thread,
      openPublishedArtifact: mocks.dispatch,
      setRightPanelMode: mocks.panel,
      setRightPanelOpen: mocks.visible,
    }),
  },
}));
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
    mocks.thread = 'thread-source';
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ artifacts: [artifact] }) });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  async function render() {
    await act(async () =>
      root.render(<FileBlock block={block} messageId="message-source" sourceThreadId="thread-source" />),
    );
  }

  it('offers Open separately from Download and uses the canonical publication identity', async () => {
    await render();
    const open = container.querySelector<HTMLButtonElement>('[data-testid="file-block-open"]');
    expect(open).not.toBeNull();
    await act(async () => open?.click());
    expect(mocks.fetch).toHaveBeenCalledWith('/api/threads/thread-source/artifacts', expect.any(Object));
    expect(mocks.dispatch).toHaveBeenCalledWith('thread-source', artifact);
    expect(container.querySelector('a[download]')?.getAttribute('href')).toBe(artifact.url);
  });

  it('does not guess by filename or URL when the publication belongs to another message', async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ artifacts: [{ ...artifact, sourceMessageId: 'different-message' }] }),
    });
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="file-block-open"]')?.click());
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
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="file-block-open"]')?.click());
    expect(mocks.dispatch).toHaveBeenCalledWith('thread-source', artifact);
  });

  it('does not navigate a different thread after a delayed catalog response', async () => {
    let finish: (result: unknown) => void = () => {};
    mocks.fetch.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="file-block-open"]')?.click());
    mocks.thread = 'thread-elsewhere';
    await act(async () => finish({ ok: true, json: async () => ({ artifacts: [artifact] }) }));
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
