import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { artifactObjectId } from '@/components/workbench/real-surface-adapters';
import { useChatStore } from '@/stores/chatStore';
import { HomeWorksSummary } from '../HomeWorksSummary';

const read = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: '', apiFetch: read.apiFetch }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: () => ({ nickname: '小太阳·砚砚', displayName: '缅因猫' }) }),
}));

const artifact: ThreadArtifactDTO = {
  type: 'image',
  name: '受控样本 · 精确发布图',
  catId: 'codex61-sol',
  createdAt: Date.UTC(2026, 9, 11),
  sourceMessageId: 'controlled-publication-exact',
  publicationItem: { kind: 'content-block', index: 2 },
  url: '/uploads/controlled-owner-revision.png',
  work: { contentRef: `prepared-media:${'c'.repeat(64)}`, ownerRevision: 4, currentOwnerRevision: 9 },
};

describe('Home consumes the original thread owner-version read', () => {
  let host: HTMLDivElement;
  let root: Root;
  const openOriginal = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    writeShellLanguage('zh');
    read.apiFetch.mockReset();
    openOriginal.mockReset();
    useChatStore.setState({
      currentThreadId: 'thread-owner-read',
      messages: [],
      hasActiveInvocation: false,
      threadStates: {},
    });
    host = document.createElement('div');
    host.dataset.testid = 'f307-workspace-home-page';
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  async function render(items: ThreadArtifactDTO[], workLineage: 'resolved' | 'unavailable') {
    // Serialize the released GET shape through the real useThreadArtifacts hook.
    read.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/content-publications/resolve')
        return Response.json({
          status: 'resolved',
          ownerUserId: 'operator',
          asset: {
            contentRef: artifact.work!.contentRef,
            ownerRevision: 4,
            blobDigest: `sha256:${'a'.repeat(64)}`,
            mediaType: 'image/png',
            media: { kind: 'image', width: 160, height: 100 },
            sourcePublication: {
              artifactRef: artifact.url,
              sourceRef: `message:thread-owner-read:${artifact.sourceMessageId}`,
              revision: String(artifact.createdAt),
            },
            ownerReceiptRef: 'receipt',
          },
        });
      return Response.json({
        threadId: 'thread-owner-read',
        artifacts: items,
        workLineage,
        view: 'works',
        total: items.length,
        complete: true,
      });
    });
    await act(async () =>
      root.render(
        <HomeWorksSummary
          threadId="thread-owner-read"
          worktreeId={null}
          onSelectDestination={vi.fn()}
          onOpenArtifact={openOriginal}
        />,
      ),
    );
  }
  it('displays the exact publication ownerRevision and passes its complete DTO to the original annotation owner', async () => {
    await render([artifact], 'resolved');
    expect(read.apiFetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/threads/thread-owner-read/artifacts?view=works',
    ]);
    expect(host.querySelector('.home-work-meta')?.textContent).toContain('小太阳·砚砚 · 第 4 版');
    expect(host.textContent).not.toContain('第 9 版');
    expect(host.querySelector('.home-work-meta')?.textContent).toContain('旧版');
    const card = host.querySelector<HTMLButtonElement>('[data-testid="workspace-home-artifact-card"]');
    if (!card) throw new Error('The original Home card must be readable');
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 12, 288, 100));
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 34, 288, 480));
    await act(async () => card.click());
    const annotate = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (button) => button.dataset.testid === 'lightbox-open-workspace',
    );
    expect(annotate).toBeDefined();
    await act(async () => annotate?.click());
    expect(useChatStore.getState().workspaceOpenRequest?.target).toMatchObject({
      kind: 'publication',
      contentRef: artifact.work!.contentRef,
      ownerRevision: 4,
      navigationOrigin: {
        kind: 'workspace-home-artifact',
        threadId: 'thread-owner-read',
        artifactId: artifactObjectId(artifact),
        viewportOffsetPx: -22,
      },
    });
  });
  it.each([
    'resolved',
    'unavailable',
  ] as const)('keeps the publication readable without inventing a version label when lineage is %s and the item has no work', async (lineage) => {
    const unprepared = { ...artifact };
    delete unprepared.work;
    await render([unprepared], lineage);
    expect(host.querySelector('.home-work-meta')?.textContent).not.toContain('版本未知');
    expect(host.querySelector('.home-work-meta')?.textContent).toMatch(/^小太阳·砚砚 · \d+\/\d+ \d+:\d+$/);
    expect(host.querySelector('img')?.getAttribute('src')).toBe(artifact.url);
    expect(host.textContent).not.toMatch(/第 [49] 版/);
  });
  it('keeps a latest document first as a compact card rather than promoting an older image', async () => {
    const document = {
      type: 'file' as const,
      name: 'Delivered.md',
      catId: artifact.catId,
      createdAt: artifact.createdAt + 1000,
      sourceMessageId: 'delivered-md',
      publicationItem: { kind: 'rich-file' as const, blockId: 'md' },
      url: '/uploads/delivered.md',
    };
    await render([document, artifact], 'resolved');
    const first = host.querySelector<HTMLButtonElement>('[data-testid="workspace-home-artifact-card"]');
    expect(first?.textContent).toContain(document.name);
    expect(first?.classList.contains('home-work-summary')).toBe(true);
    expect(first?.querySelector('img')).toBeNull();
    expect(host.querySelectorAll('[data-testid="workspace-home-artifact-card"]')[1]?.querySelector('img')).toBeNull();
  });
  it('a failed latest image becomes a compact unavailable preview without substituting another work', async () => {
    await render([artifact], 'resolved');
    const image = host.querySelector('img');
    await act(async () => image?.dispatchEvent(new Event('error')));
    const card = host.querySelector('[data-testid="workspace-home-artifact-card"]');
    expect(card?.querySelector('img')).toBeNull();
    expect(card?.textContent).toContain(artifact.name);
    expect(host.textContent).toContain('无法读取图片');
  });
  it('rereads the original catalogue for material changes, completion, deletion and owner invalidation without token polling', async () => {
    await render([], 'resolved');
    expect(read.apiFetch).toHaveBeenCalledTimes(1);
    read.apiFetch.mockImplementation(async () =>
      Response.json({ artifacts: [artifact], workLineage: 'resolved', view: 'works', complete: true, total: 1 }),
    );
    const message = {
      id: 'controlled-publication-exact',
      type: 'assistant' as const,
      content: 'stream chunk',
      timestamp: artifact.createdAt,
      isStreaming: true,
    };
    await act(async () => useChatStore.setState({ messages: [message], hasActiveInvocation: true }));
    expect(host.querySelector('[data-testid="workspace-home-artifact-card"]')).not.toBeNull();
    const materialReads = read.apiFetch.mock.calls.length;
    await act(async () => useChatStore.setState({ messages: [{ ...message, content: 'another stream chunk' }] }));
    expect(read.apiFetch).toHaveBeenCalledTimes(materialReads);
    await act(async () =>
      useChatStore.setState({ messages: [{ ...message, isStreaming: false }], hasActiveInvocation: false }),
    );
    expect(read.apiFetch).toHaveBeenCalledTimes(materialReads + 1);
    const card = host.querySelector<HTMLButtonElement>('[data-testid="workspace-home-artifact-card"]');
    await act(async () => card?.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    read.apiFetch.mockImplementation(async () =>
      Response.json({ artifacts: [], workLineage: 'resolved', view: 'works', complete: true, total: 0 }),
    );
    await act(async () => useChatStore.setState({ messages: [] }));
    expect(host.querySelector('[data-testid="workspace-home-artifact-card"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).toContain('无法打开这件作品');
    const deletedReads = read.apiFetch.mock.calls.length;
    await act(async () => window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated')));
    expect(read.apiFetch).toHaveBeenCalledTimes(deletedReads + 1);
  });
  it('observes the original current-thread liveness signal even when no message material changes', async () => {
    await render([], 'resolved');
    const initialReads = read.apiFetch.mock.calls.length;
    await act(async () => useChatStore.setState({ hasActiveInvocation: true }));
    expect(read.apiFetch).toHaveBeenCalledTimes(initialReads + 1);
    read.apiFetch.mockImplementation(async () =>
      Response.json({ artifacts: [artifact], workLineage: 'resolved', view: 'works', complete: true, total: 1 }),
    );
    await act(async () => useChatStore.setState({ hasActiveInvocation: false }));
    expect(read.apiFetch).toHaveBeenCalledTimes(initialReads + 2);
    expect(host.querySelector('[data-testid="workspace-home-artifact-card"]')).not.toBeNull();
  });
});
