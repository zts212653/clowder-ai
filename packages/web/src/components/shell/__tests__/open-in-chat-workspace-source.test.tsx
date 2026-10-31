import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { useOpenInChat } from '../use-open-in-chat';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/settings', useRouter: () => nav }));

// Settings parks Chat at default. Opening a panel must bind to the return conversation
// before creating/consuming its request; otherwise the real shell restores Home on return.
it('opens Workspace in the Settings return conversation, not the parked default conversation', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  history.replaceState(null, '', '/settings?from=thread-source');
  useChatStore.setState({
    currentThreadId: 'default',
    workspaceOpenRevision: 0,
    workspaceOpenRequest: null,
    threadStates: {},
  });
  function Entry() {
    const openInChat = useOpenInChat();
    return (
      <button type="button" onClick={() => openInChat(() => useChatStore.getState().openEvolutionWorkspace())}>
        能力进化
      </button>
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Entry />));
    await act(async () => host.querySelector('button')?.click());
    expect(nav.push).toHaveBeenCalledWith('/thread/thread-source');
    expect(useChatStore.getState().workspaceOpenRequest).toMatchObject({
      threadId: 'thread-source',
      target: { kind: 'evolution-home' },
    });
    expect(useChatStore.getState().threadStates['thread-source']).toMatchObject({
      rightPanelOpen: true,
      rightPanelMode: 'workspace',
    });
  } finally {
    act(() => root.unmount());
    host.remove();
    history.replaceState(null, '', '/');
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
