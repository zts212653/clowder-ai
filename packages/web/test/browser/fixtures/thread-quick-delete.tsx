import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { YouSettingsPage } from '@/components/settings/YouSettingsPage';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { ThemeApplier } from '@/components/ThemeApplier';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ThreadSidebar } from '@/components/ThreadSidebar/ThreadSidebar';
import {
  getBrowserThreadRoutePathname,
  subscribeBrowserThreadRoute,
} from '@/components/ThreadSidebar/thread-navigation';
import { ToastContainer } from '@/components/ToastContainer';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import { useChatStore } from '@/stores/chatStore';
import { useThemeStore } from '@/stores/themeStore';
import { apiFetch, refreshApiSession } from '@/utils/api-client';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/connector-tokens.css';
import '@/app/console-tokens.css';
import '@/app/console-shell.css';
import '@/app/console-controls.css';
import '@/app/shell-v2.css';
import '@/components/chat-background/chat-background.css';

const coCreator = { name: '隔离验收用户', aliases: [], mentionPatterns: ['@fixture'] };
primeCoCreatorConfigCache(coCreator);

function ThreadDeletionJourney() {
  // Next destinations and the chat layout's same-document navigation both own route updates.
  usePathname();
  const pathname = useSyncExternalStore(subscribeBrowserThreadRoute, getBrowserThreadRoutePathname);
  const router = useRouter();
  const presentation = useShellPresentation();
  const [history, setHistory] = useState<string[]>([]);
  const currentThread = pathname.startsWith('/thread/') ? pathname.slice('/thread/'.length) : 'default';
  const settings = pathname === '/settings';
  useEffect(() => {
    document.documentElement.dataset.shell = presentation;
    useChatStore.setState({ currentThreadId: currentThread });
    if (settings) return;
    void apiFetch(`/api/messages?threadId=${encodeURIComponent(currentThread)}`)
      .then((response) => response.json())
      .then((body: { messages: { content: string }[] }) => setHistory(body.messages.map((message) => message.content)));
  }, [currentThread, presentation, settings]);
  return (
    <div style={{ display: 'flex', height: '100dvh', background: 'var(--console-shell-bg)' }}>
      <div style={{ width: 300, flexShrink: 0, minWidth: 0 }}>
        <ThreadSidebar routeThreadId={currentThread} className="h-full w-full min-w-0" />
      </div>
      <main className="min-w-0 flex-1 overflow-auto p-6">
        <nav className="mb-5 flex gap-4">
          <button type="button" className="you-settings-button" onClick={() => router.push('/settings')}>
            个人设置
          </button>
          <button type="button" className="you-settings-button" onClick={() => router.push('/')}>
            返回大厅
          </button>
        </nav>
        {settings ? (
          <YouSettingsPage coCreator={coCreator} loadError={false} reload={async () => {}} />
        ) : (
          <section data-testid="restored-history">
            <h1 className="mb-4 text-lg font-semibold">{currentThread === 'default' ? '大厅' : '对话历史'}</h1>
            {history.map((content) => (
              <p key={content}>{content}</p>
            ))}
          </section>
        )}
      </main>
      <ToastContainer />
    </div>
  );
}

declare global {
  interface Window {
    __threadDeleteTheme: (base: 'light' | 'dark') => void;
    __threadDeleteRefreshSession: () => Promise<void>;
  }
}
window.__threadDeleteTheme = (base) => useThemeStore.getState().setActive(base);
window.__threadDeleteRefreshSession = refreshApiSession;
const root = document.getElementById('root');
if (!root) throw new Error('Missing browser fixture root');
createRoot(root).render(
  <ThemeProvider>
    <ThemeApplier />
    <ThreadDeletionJourney />
  </ThemeProvider>,
);
