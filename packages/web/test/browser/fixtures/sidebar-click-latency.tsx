import { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { ThreadSidebar } from '@/components/ThreadSidebar/ThreadSidebar';
import {
  getBrowserThreadRoutePathname,
  getThreadIdFromPathname,
  subscribeBrowserThreadRoute,
} from '@/components/ThreadSidebar/thread-navigation';
import { useChatStore } from '@/stores/chatStore';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/shell-v2.css';

// Only route hosting and transport are private. Sidebar, grouping, draft owner,
// optimistic commands, navigation writer and DOM measurements are production code.
writeShellPresentation('v2');
writeShellLanguage('en');
document.documentElement.dataset.shell = 'v2';
const params = new URLSearchParams(location.search);
localStorage.setItem('cat-cafe:sidebar:active-tab', params.get('tab') ?? 'pinned');
useChatStore.setState({ currentThreadId: 'row-0', currentProjectPath: '/private/sidebar' });
subscribeBrowserThreadRoute(() => {
  useChatStore.getState().setCurrentThread(getThreadIdFromPathname(location.pathname));
});
function Host() {
  const pathname = useSyncExternalStore(subscribeBrowserThreadRoute, getBrowserThreadRoutePathname);
  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <div style={{ width: 360, height: '100%', flexShrink: 0 }}>
        <ThreadSidebar routeThreadId={getThreadIdFromPathname(pathname)} className="w-full" />
      </div>
      <main>Private sidebar performance fixture; chat body excluded.</main>
    </div>
  );
}
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('missing private fixture root');
createRoot(rootElement).render(<Host />);
Object.assign(window, {
  __sidebarClick: {
    state: () => ({
      rows: useSidebarProjectionStore.getState().rows.length,
      commands: useSidebarProjectionStore.getState().pendingThreadCommands,
      current: useChatStore.getState().currentThreadId,
    }),
  },
});
