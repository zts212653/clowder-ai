// @vitest-environment jsdom
/** F232 entries consume the shared content owner; list state does not own a second detail view. */
import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { F307ArtifactOwnerSurface } from '@/components/workbench/F307ArtifactOwnerSurface';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';

const { mockState } = vi.hoisted(() => ({
  mockState: { artifacts: [] as ThreadArtifactDTO[] },
}));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://test.local', apiFetch: vi.fn() }));
vi.mock('@/hooks/useThreadArtifacts', async (original) => ({
  ...(await original<object>()),
  useThreadArtifacts: () => ({ artifacts: mockState.artifacts, loading: false, error: null }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (id: string) =>
      id === 'opus-48' ? { displayName: '布偶猫', variantLabel: '4.8', nickname: '宪宪' } : undefined,
  }),
}));

import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { ArtifactsPanel } from '../ArtifactsPanel';

const roots = new Set<ReturnType<typeof createRoot>>();
const origin = {
  kind: 'artifact-list',
  threadId: 'T',
  view: { scope: 'thread', filter: 'all', query: '', grouping: 'time', catFilter: null, collapsed: [] },
};
const item = { kind: 'media-gallery' as const, blockId: 'original-gallery', itemIndex: 1 };
const image: ThreadArtifactDTO = {
  type: 'image',
  name: 'arch.png',
  catId: 'opus-48',
  createdAt: 12345,
  sourceMessageId: 'original',
  publicationItem: item,
  url: '/uploads/arch.png',
};
const source = {
  kind: 'message',
  threadId: 'T',
  messageId: 'original',
  messageRevision: '12345',
  item,
  expectedUrl: image.url,
};
const asset = {
  contentRef: `prepared-media:${'c'.repeat(64)}`,
  ownerRevision: 2,
  blobDigest: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png',
  media: { kind: 'image', width: 160, height: 100 },
  sourcePublication: { artifactRef: image.url, sourceRef: 'message:T:original', revision: '12345' },
  ownerReceiptRef: 'receipt-exact',
};
const landing = () => Response.json({ status: 'resolved', ownerUserId: 'operator', asset });

function renderPanel(props: Partial<Parameters<typeof ArtifactsPanel>[0]> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  act(() => root.render(createElement(ArtifactsPanel, { threadId: 'T', ...props })));
  return { container, root };
}
async function clickRow(container: HTMLElement) {
  const row = container.querySelector<HTMLElement>('[data-artifact-row]');
  expect(row).not.toBeNull();
  await act(async () => row!.click());
}

describe('F232 AC-A7 shared content entry', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    localStorage.clear();
    writeShellPresentation('classic');
    writeShellLanguage('zh');
    useChatStore.setState({ currentThreadId: 'T', workspaceWorktreeId: null, workspaceOpenRequest: null });
    vi.mocked(apiFetch)
      .mockReset()
      .mockImplementation(async (url) => {
        if (url === '/api/content-publications/resolve') return landing();
        throw new Error(`Unexpected source read: ${url}`);
      });
    mockState.artifacts = [];
  });
  afterEach(() => {
    act(() => {
      for (const root of roots) root.unmount();
    });
    roots.clear();
    document.body.innerHTML = '';
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('opens the exact PR in the existing F307 owner and retains the list return', async () => {
    const artifact: ThreadArtifactDTO = {
      type: 'pr',
      name: 'PR #2247',
      catId: 'opus-48',
      createdAt: 42,
      sourceMessageId: null,
      ref: 'example/project#2247',
    };
    mockState.artifacts = [artifact];
    const selected = vi.fn();
    const { container } = renderPanel({ onSelectArtifact: selected });
    const search = container.querySelector('input');
    await clickRow(container);
    const surface = selected.mock.calls[0]?.[2] as WorkspaceSurfaceDescriptor;
    expect(surface.navigationOrigin).toEqual(origin);
    expect(surface.ownerStateRef).toEqual({ owner: 'f232-thread-artifacts', key: 'T' });
    const owner = document.createElement('div');
    document.body.appendChild(owner);
    const root = createRoot(owner);
    roots.add(root);
    const detach = vi.fn();
    await act(async () =>
      root.render(
        createElement(F307ArtifactOwnerSurface, {
          surface,
          onRequestDetach: detach,
          onOpenSurface: vi.fn(),
        }),
      ),
    );
    expect(owner.querySelector('a')?.getAttribute('href')).toBe('https://github.com/example/project/pull/2247');
    const back = owner.querySelector<HTMLButtonElement>('button[aria-label="返回"]');
    expect(back).not.toBeNull();
    await act(async () => back!.click());
    expect(detach).toHaveBeenCalledOnce();
    expect(container.querySelector('input')).toBe(search);
    expect(container.querySelector('button[aria-label="返回"]')).toBeNull();
  });

  it('AC-A5: displays the configured member name and relative time', () => {
    mockState.artifacts = [
      { type: 'pr', name: 'PR #1', catId: 'opus-48', createdAt: Date.now(), sourceMessageId: null, ref: 'o/r#1' },
    ];
    const { container } = renderPanel();
    expect(container.textContent).toContain('布偶猫（4.8）');
    expect(container.textContent).not.toContain('opus-48');
    expect(container.textContent).toContain('刚刚');
  });

  it('keeps a source-less image as a preview without granting an editable owner or work mode', async () => {
    mockState.artifacts = [{ ...image, sourceMessageId: null, publicationItem: undefined }];
    const { container } = renderPanel();
    await clickRow(container);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.querySelector('img')?.getAttribute('src')).toBe('http://test.local/uploads/arch.png');
    expect(dialog?.querySelector('[data-testid="lightbox-open-workspace"]')).toBeNull();
    expect(dialog?.querySelector('[data-testid="artwork-annotation-toolbar"]')).toBeNull();
    expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('resolves the exact message item before opening its publication and preserves the list origin', async () => {
    mockState.artifacts = [image];
    const { container } = renderPanel();
    await clickRow(container);
    expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
    const action = document.querySelector<HTMLButtonElement>('[data-testid="lightbox-open-workspace"]');
    expect(action).not.toBeNull();
    await act(async () => action!.click());
    expect(apiFetch).toHaveBeenCalledTimes(2); // admission, then revalidation on explicit work-mode transition
    for (const [url, init] of vi.mocked(apiFetch).mock.calls) {
      expect(url).toBe('/api/content-publications/resolve');
      expect(JSON.parse(String(init?.body))).toEqual({ source, operationId: expect.any(String) });
    }
    expect(useChatStore.getState().workspaceOpenRequest?.target).toEqual({
      kind: 'publication',
      contentRef: asset.contentRef,
      ownerRevision: 2,
      messagePublicationSource: source,
      title: image.name,
      navigationOrigin: origin,
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('lets the F307 adapter consume the exact DTO and resolved descriptor without a selected-record copy', async () => {
    const artifact: ThreadArtifactDTO = {
      type: 'pr',
      name: 'PR #4030',
      catId: 'opus-48',
      createdAt: 42,
      sourceMessageId: 'message-review',
      ref: 'zts212653/clowder-ai#4030',
    };
    mockState.artifacts = [artifact];
    const selected = vi.fn();
    const { container } = renderPanel({ onSelectArtifact: selected });
    await clickRow(container);
    expect(selected).toHaveBeenCalledExactlyOnceWith(
      artifact,
      origin,
      expect.objectContaining({
        renderer: 'review-summary',
        ownerStateRef: { owner: 'f232-thread-artifacts', key: 'T' },
        resultTargetRef: { owner: 'thread-message', key: 'T:message-review' },
        navigationOrigin: origin,
      }),
    );
    expect(selected.mock.calls[0][0]).toBe(artifact);
    expect(container.querySelector('input')).not.toBeNull();
  });

  it.each([401, 403])('does not show a cached image or grant work mode after owner denial (%s)', async (status) => {
    mockState.artifacts = [image];
    vi.mocked(apiFetch).mockImplementation(async () => Response.json({ error: 'access_denied' }, { status }));
    const { container } = renderPanel();
    await clickRow(container);
    expect(apiFetch).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法访问原作品');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
  });

  it('discards a late source result when the same mounted list switches threads', async () => {
    let finish!: (value: Response) => void;
    vi.mocked(apiFetch).mockReturnValue(
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
    );
    mockState.artifacts = [image];
    const { container, root } = renderPanel();
    await clickRow(container);
    expect(apiFetch).toHaveBeenCalledOnce();
    mockState.artifacts = [
      { type: 'pr', name: 'T2 own PR', catId: 'opus-48', createdAt: 42, sourceMessageId: null, ref: 'o/r#2' },
    ];
    await act(async () => {
      useChatStore.setState({ currentThreadId: 'T2' });
      root.render(createElement(ArtifactsPanel, { threadId: 'T2' }));
    });
    await act(async () => finish(landing()));
    expect(container.querySelector('input')).not.toBeNull();
    expect(container.textContent).toContain('T2 own PR');
    expect(container.textContent).not.toContain(image.name);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
  });
});
