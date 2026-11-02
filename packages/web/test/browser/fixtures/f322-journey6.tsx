import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { CatHueInjector } from '@/components/CatHueInjector';
import { CoCreatorHueInjector } from '@/components/CoCreatorHueInjector';
import { MessageSearchButton } from '@/components/message-search/MessageSearchButton';
import { MessageSearchOverlay } from '@/components/message-search/MessageSearchOverlay';
import { useMessageSearchHost } from '@/components/message-search/useMessageSearchHost';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { ThemeApplier } from '@/components/ThemeApplier';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ThreadChatRuntimeProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { ThreadChatSurface } from '@/components/thread-chat/ThreadChatSurface';
import type { RegisterChatReadingPort } from '@/components/thread-chat/useThreadChatReadingPort';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { CURRENT_THREAD } from './f322-chat-real-page-data.mjs';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/console-shell.css';
import '@/app/cat-persona-tokens.css';
import '@/app/shell-v2.css';

primeCoCreatorConfigCache({
  name: 'You',
  aliases: [],
  mentionPatterns: [],
  color: { primary: '#6B5443', secondary: '#E9DCCF' },
});
useChatStore.setState({ currentThreadId: CURRENT_THREAD });
// AppShell normally hydrates the thread list. Keep that read boundary here too.
void apiFetch('/api/threads')
  .then((response) => response.json())
  .then((body) => useChatStore.getState().setThreads(body.threads));

function JourneyContent({ threadId }: { threadId: string }) {
  const router = useRouter();
  const host = useMessageSearchHost({ threadId, pushThreadRoute: (next) => router.push(`/thread/${next}`) });
  const registerReadingPort = useCallback<RegisterChatReadingPort>(
    (port) => {
      console.info(
        'j6-navigation',
        JSON.stringify({ event: 'register', threadId: port.threadId, ownerId: port.ownerId }),
      );
      const dispose = host.registerReadingPort({
        ...port,
        navigateToMessage: async (...args) => {
          console.info(
            'j6-navigation',
            JSON.stringify({ event: 'enter', threadId: port.threadId, ownerId: port.ownerId }),
          );
          const result = await port.navigateToMessage(...args);
          console.info(
            'j6-navigation',
            JSON.stringify({ event: 'receipt', threadId: port.threadId, ownerId: port.ownerId, result }),
          );
          return result;
        },
      });
      return () => {
        console.info(
          'j6-navigation',
          JSON.stringify({ event: 'release', threadId: port.threadId, ownerId: port.ownerId }),
        );
        dispose();
      };
    },
    [host.registerReadingPort],
  );
  const title = useChatStore((state) => state.threads.find((thread) => thread.id === threadId)?.title);
  const presentation = useShellPresentation();
  useLayoutEffect(() => {
    document.documentElement.dataset.shell = presentation;
    useChatStore.getState().setCurrentThread(threadId);
  }, [presentation, threadId]);
  return (
    <div className="relative mx-auto flex h-screen w-full max-w-[1120px] flex-col bg-cafe-canvas">
      <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-[var(--console-border-soft)] px-6 text-sm text-cafe-black">
        <span>{title || '继续刚才的设计'}</span>
        <MessageSearchButton onOpen={host.openSearch} open={host.open} />
      </header>
      <MessageSearchOverlay
        threadId={threadId}
        host={host}
        available
        resolveSpeaker={(speaker) => (speaker === 'user' ? 'You' : speaker === 'opus55' ? '宪宪' : '砚砚')}
      />
      <ThreadChatSurface threadId={threadId} density="full" onReadingPort={registerReadingPort} />
    </div>
  );
}
function JourneyPage() {
  const threadId = usePathname().split('/').at(-1) || CURRENT_THREAD;
  return (
    <ThreadChatRuntimeProvider routeThreadId={threadId}>
      <JourneyContent threadId={threadId} />
    </ThreadChatRuntimeProvider>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing journey mount');
createRoot(root).render(
  <ThemeProvider>
    <CatHueInjector />
    <CoCreatorHueInjector />
    <ThemeApplier />
    <JourneyPage />
  </ThemeProvider>,
);
