import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ArtworkLightboxProvider, useArtworkLightboxScope } from '@/components/content-review/ArtworkLightboxScope';
import { createPublicationSurface } from '@/components/workbench/publication-surface';
import { useChatStore } from '@/stores/chatStore';
import { LivingWorkCard } from '../LivingWorkCard';

const reference = { contentRef: `work:${'a'.repeat(64)}`, ownerRevision: 1 };
const block = {
  id: 'delivery',
  v: 1 as const,
  kind: 'card' as const,
  title: '第一版片子',
  bodyMarkdown: '原版整段说明不上卡',
  meta: { kind: 'work_reference', reference },
};
const fetcher = vi.fn();
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3102',
  apiFetch: (...args: unknown[]) => fetcher(...args),
}));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));
afterEach(() => vi.clearAllMocks());
const description = (revision = 1) => ({
  asset: { ...reference, ownerRevision: revision, mediaType: 'video/mp4', blobDigest: `sha256:${'b'.repeat(64)}` },
  currentOwnerRevision: 3,
});
function FloatingProbe() {
  const scope = useArtworkLightboxScope();
  return (
    <>
      <output data-testid="floating-version">{scope?.work?.surface?.ownerStateRef.key}</output>
      <button type="button" onClick={scope?.close}>
        收起浮窗
      </button>
      <button type="button" onClick={() => void scope?.work?.openWorkspace?.()}>
        浮窗进作品模式
      </button>
      <button
        type="button"
        onClick={() =>
          scope?.resolve(createPublicationSurface({ ...reference, ownerRevision: 2, title: '第二版片子' }))
        }
      >
        浮窗切第2版
      </button>
      <button
        type="button"
        onClick={() => scope?.resolve(createPublicationSurface({ ...reference, title: '第一版片子' }))}
      >
        浮窗切第1版
      </button>
    </>
  );
}

it('cover previews the fixed owner, Open enters work mode, and the newest badge never rewrites the source card', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const opened = vi.fn(() => true),
    originalOpen = useChatStore.getState().openPublication;
  useChatStore.setState({ currentThreadId: 'host', openPublication: opened });
  fetcher.mockResolvedValue({ ok: true, json: async () => description() });
  const host = document.createElement('div'),
    root = createRoot(host);
  const button = (text: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === text)!;
  try {
    await act(async () =>
      root.render(
        <ArtworkLightboxProvider threadId="host">
          <LivingWorkCard block={block} messageId="original-message" />
          <FloatingProbe />
        </ArtworkLightboxProvider>,
      ),
    );
    expect(host.textContent).not.toContain(block.bodyMarkdown);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="workspace-home-artifact-card"]')?.click(),
    );
    expect(host.querySelector('[data-testid="floating-version"]')?.textContent).toContain('"ownerRevision":1');
    expect(opened).not.toHaveBeenCalled();
    await act(async () => button('收起浮窗').click());
    await act(async () => button('打开').click());
    expect(opened).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ...reference,
        navigationOrigin: { kind: 'chat-file-link', threadId: 'host', messageId: 'original-message' },
      }),
      'host',
      'work-mode',
    );
    fetcher.mockResolvedValueOnce({ ok: true, json: async () => description(3) });
    await act(async () => button('已有第 3 版').click());
    expect(host.querySelector('[data-testid="floating-version"]')?.textContent).toContain('"ownerRevision":3');
    expect(block.meta.reference.ownerRevision).toBe(1);
    expect(host.querySelector('[data-work-reference]')?.getAttribute('data-work-reference')).toContain(
      '"ownerRevision":1',
    );
    fetcher.mockResolvedValueOnce({ ok: true, json: async () => description(3) });
    await act(async () => button('浮窗进作品模式').click());
    expect(fetcher.mock.lastCall?.[0]).toContain('?ownerRevision=3');
    expect(opened).toHaveBeenLastCalledWith(
      expect.objectContaining({ ...reference, ownerRevision: 3 }),
      'host',
      'work-mode',
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="workspace-home-artifact-card"]')?.click(),
    );
    await act(async () => button('浮窗切第2版').click());
    expect(host.querySelector('[data-testid="floating-version"]')?.textContent).toContain('"ownerRevision":2');
    fetcher.mockResolvedValueOnce({ ok: true, json: async () => description(2) });
    await act(async () => button('浮窗进作品模式').click());
    expect(fetcher.mock.lastCall?.[0]).toContain('?ownerRevision=2');
    expect(opened).toHaveBeenLastCalledWith(
      expect.objectContaining({ ...reference, ownerRevision: 2 }),
      'host',
      'work-mode',
    );
    // A version selected while expansion reauthorizes invalidates that pending expansion too.
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="workspace-home-artifact-card"]')?.click(),
    );
    await act(async () => button('浮窗切第2版').click());
    let finish: (result: unknown) => void = () => {};
    fetcher.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    opened.mockClear();
    await act(async () => button('浮窗进作品模式').click());
    await act(async () => button('浮窗切第1版').click());
    await act(async () => finish({ ok: true, json: async () => description(2) }));
    expect(opened).not.toHaveBeenCalled();
    await act(async () => button('收起浮窗').click());
    opened.mockClear();
    fetcher.mockResolvedValueOnce({ ok: false, status: 403 });
    await act(async () => button('打开').click());
    expect(opened).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('暂时无法打开');
  } finally {
    await act(async () => root.unmount());
    useChatStore.setState({ openPublication: originalOpen });
  }
});
