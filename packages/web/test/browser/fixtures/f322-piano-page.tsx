import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { CatHueInjector } from '@/components/CatHueInjector';
import { CoCreatorHueInjector } from '@/components/CoCreatorHueInjector';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { ThemeApplier } from '@/components/ThemeApplier';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ThreadChatRuntimeProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { ThreadChatSurface } from '@/components/thread-chat/ThreadChatSurface';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import { useChatStore } from '@/stores/chatStore';
import { useThemeStore } from '@/stores/themeStore';
import { BUSY_THREAD, CURRENT_THREAD } from './f322-chat-real-page-data.mjs';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/console-shell.css';
import '@/app/cat-persona-tokens.css';
import '@/app/shell-v2.css';

primeCoCreatorConfigCache({
  name: 'Fixture Owner',
  aliases: [],
  mentionPatterns: [],
  color: { primary: '#6B5443', secondary: '#E9DCCF' },
});
useChatStore.setState({ currentThreadId: location.pathname.split('/').at(-1) || CURRENT_THREAD });

// Only the host dimensions, routing and transport are fixtures. The complete
// surface, row mount policy, composer, reading owner and styles are production.
function PianoPage() {
  const pathname = usePathname();
  const router = useRouter();
  const threadId = pathname.split('/').at(-1) || CURRENT_THREAD;
  const params = new URLSearchParams(location.search);
  const width = Number(params.get('pane')) || 900;
  const density = params.get('compact') === '1' ? 'compact' : 'full';
  const presentation = useShellPresentation();
  useEffect(() => {
    document.documentElement.dataset.shell = presentation;
    useChatStore.getState().setCurrentThread(threadId);
  }, [presentation, threadId]);
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-cafe-canvas">
      <nav className="flex shrink-0 gap-3 p-2 text-xs">
        <button type="button" onClick={() => router.push(`/thread/${BUSY_THREAD}${location.search}`)}>
          Other thread
        </button>
        <button type="button" onClick={() => useThemeStore.getState().setActive('light')}>
          Light
        </button>
        <button type="button" onClick={() => useThemeStore.getState().setActive('dark')}>
          Dark
        </button>
      </nav>
      <div data-piano-host className="mx-auto flex min-h-0 flex-1" style={{ width, maxWidth: '100%' }}>
        <ThreadChatRuntimeProvider routeThreadId={threadId}>
          <ThreadChatSurface threadId={threadId} density={density} />
        </ThreadChatRuntimeProvider>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing piano page root');
createRoot(root).render(
  <ThemeProvider>
    <CatHueInjector />
    <CoCreatorHueInjector />
    <ThemeApplier />
    <PianoPage />
  </ThemeProvider>,
);
