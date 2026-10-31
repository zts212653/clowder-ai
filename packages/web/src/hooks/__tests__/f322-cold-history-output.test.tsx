import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { __resetTaskCacheForTest, useChatHistory } from '../useChatHistory';
import { stations } from './f322-real-readback.fixture';
import { cleanStoreState } from './useAgentMessages-codex-tool-text-convergence.helpers';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/offline-store', () => ({
  loadThreadMessages: vi.fn().mockResolvedValue(null),
  saveThreadMessages: vi.fn().mockResolvedValue(undefined),
  loadThreadActiveState: vi.fn().mockResolvedValue(null),
  saveThreadActiveState: vi.fn().mockResolvedValue(undefined),
  loadThreads: vi.fn().mockResolvedValue(null),
  saveThreads: vi.fn().mockResolvedValue(undefined),
  clearAll: vi.fn().mockResolvedValue(undefined),
}));
function Probe({ threadId }: { threadId: string }) {
  useChatHistory(threadId);
  return null;
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  __resetTaskCacheForTest();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.mocked(apiFetch).mockReset();
});

for (const trace of stations) {
  for (const [kind, message] of [
    ['formal', trace.api],
    ['draft', trace.draft.api],
  ] as const) {
    it(`${trace.route}/${kind}: actual cold HTTP history whitelist retains the original output proof`, async () => {
      cleanStoreState(trace.threadId);
      vi.mocked(apiFetch).mockImplementation(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.includes('/api/messages')
                ? { messages: [message], hasMore: false }
                : url.includes('/queue')
                  ? { queue: [], paused: false, activeInvocations: [] }
                  : { tasks: [] },
            ),
            { status: 200 },
          ),
      );
      await act(async () => {
        root.render(
          <ThreadChatHistoryAdmissionProvider>
            <Probe threadId={trace.threadId} />
          </ThreadChatHistoryAdmissionProvider>,
        );
      });
      await act(async () => {
        await vi.waitFor(() =>
          expect(useChatStore.getState().messages.find((item) => item.id === message.id)?.content).toBe(
            message.content,
          ),
        );
      });
      const hydrated = useChatStore.getState().messages.find((item) => item.id === message.id);
      expect(hydrated?.extra?.outputLayout).toEqual(message.extra.outputLayout);
      expect(hydrated?.toolEvents?.map((tool) => tool.id)).toEqual(message.toolEvents?.map((tool) => tool.id));
    });
  }
}
