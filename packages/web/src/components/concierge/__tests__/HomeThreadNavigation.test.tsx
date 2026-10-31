import { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDurableComposerDraft } from '@/components/useDurableComposerDraft';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { applyHomeCommand } from '../home-action-bridge';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const clientId = '11111111-1111-4111-8111-111111111111';
const clientToken = '22222222-2222-4222-8222-222222222222';
const destination = 'pine-unfamiliar-thread';

function DestinationComposer() {
  const threadId = useChatStore((state) => state.currentThreadId);
  const [input, setInput] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [contextAttachments, setContextAttachments] = useState<import('@cat-cafe/shared').ContextAttachment[]>([]);
  const [, setIsPreparingImages] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useDurableComposerDraft({
    threadId,
    input,
    setInput,
    images,
    setImages,
    contextAttachments,
    setContextAttachments,
    replyToMessage: null,
    textareaRef,
    setIsPreparingImages,
  });
  return (
    <main>
      <textarea aria-label={`Draft for ${threadId}`} ref={textareaRef} value={input} readOnly />
    </main>
  );
}

function begin() {
  return applyHomeCommand({
    token: '33333333-3333-4333-8333-333333333333',
    clientId,
    clientToken,
    signal: new AbortController().signal,
    navigate: vi.fn(),
    captureBeforeSettings: vi.fn(),
  });
}
async function paint(count = 1) {
  for (let i = 0; i < count; i++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  window.history.replaceState({}, '', '/thread/source');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  useChatStore.setState({
    currentThreadId: 'source',
    pendingChatInsert: null,
    isLoadingHistory: false,
    threadStates: {},
  });
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path.includes('/composer-draft')) return new Response(JSON.stringify({ draft: null, revision: 0 }));
    return new Response(
      JSON.stringify({
        kind: 'navigate',
        clientId,
        baseRoute: '/thread/source',
        expiresAt: Date.now() + 160,
        action: { kind: 'thread', threadId: destination },
      }),
    );
  });
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it('a visible sidebar row and changed URL cannot confirm a destination that never became active', async () => {
  document.body.innerHTML = `<aside><div data-thread-id="${destination}">Listed target</div></aside>`;
  const operation = begin();
  await paint(12);
  expect(window.location.pathname).toBe(`/thread/${destination}`);
  expect(useChatStore.getState().currentThreadId).toBe('source');
  expect((await operation).status).toBe('unconfirmed');
});

it('a ready active destination confirms navigation with the sidebar absent', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    const operation = begin();
    await act(async () => {
      useChatStore.setState({ currentThreadId: destination, isLoadingHistory: false });
      root.render(<DestinationComposer />);
    });
    await paint(12);
    expect(document.querySelector('[data-thread-id]')).toBeNull();
    expect(container.querySelector('textarea')?.getAttribute('aria-label')).toBe(`Draft for ${destination}`);
    expect((await operation).status).toBe('applied');
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it('a listed destination still hydrating does not confirm even after the active thread switches', async () => {
  const container = document.createElement('div');
  document.body.innerHTML = `<aside><div data-thread-id="${destination}">Listed target</div></aside>`;
  document.body.append(container);
  const root = createRoot(container);
  try {
    const operation = begin();
    await act(async () => {
      useChatStore.setState({ currentThreadId: destination, isLoadingHistory: true });
      root.render(<DestinationComposer />);
    });
    await paint(12);
    expect((await operation).status).toBe('unconfirmed');
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
