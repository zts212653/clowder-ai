import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { LivingWorkCard } from '../LivingWorkCard';

const reference = { contentRef: `work:${'a'.repeat(64)}`, ownerRevision: 1 };
const block = {
  id: 'delivery',
  v: 1 as const,
  kind: 'card' as const,
  title: '第一版片子',
  bodyMarkdown: '原版说明',
  meta: { kind: 'work_reference', reference },
};
const fetcher = vi.fn();
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => fetcher(...args) }));
afterEach(() => vi.clearAllMocks());

it('old delivery opens its exact version and an explicit latest action is separate', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const opened = vi.fn(() => true);
  const originalOpen = useChatStore.getState().openPublication;
  useChatStore.setState({ currentThreadId: 'host', openPublication: opened });
  fetcher.mockResolvedValue({
    ok: true,
    json: async () => ({
      asset: { ...reference, mediaType: 'video/mp4' },
      currentOwnerRevision: 3,
    }),
  });
  const container = document.createElement('div'),
    root = createRoot(container);
  try {
    await act(async () => root.render(<LivingWorkCard block={block} messageId="original-message" />));
    const button = (text: string) =>
      [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(text))!;
    await act(async () => button('看这版').click());
    expect(fetcher.mock.calls[0][0]).toContain('?ownerRevision=1');
    expect(opened).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ...reference,
        navigationOrigin: { kind: 'chat-file-link', threadId: 'host', messageId: 'original-message' },
      }),
      'host',
      'work-mode',
    );
    expect(container.textContent).toContain('第 1 版');
    fetcher.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        asset: { ...reference, ownerRevision: 3, mediaType: 'video/mp4' },
        currentOwnerRevision: 3,
      }),
    });
    await act(async () => button('查看最新').click());
    expect(opened).toHaveBeenLastCalledWith(
      expect.objectContaining({ ...reference, ownerRevision: 3 }),
      'host',
      'work-mode',
    );
    expect(block.meta.reference.ownerRevision).toBe(1);
    opened.mockClear();
    fetcher.mockResolvedValueOnce({ ok: false, status: 403 });
    await act(async () => button('看这版').click());
    expect(opened).not.toHaveBeenCalled();
    expect(container.textContent).toContain('暂时无法打开');
  } finally {
    await act(async () => root.unmount());
    useChatStore.setState({ openPublication: originalOpen });
  }
});
