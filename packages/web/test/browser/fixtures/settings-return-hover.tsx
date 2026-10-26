import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsReadingBridge } from '@/components/shell/settings-reading-bridge';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { type ChatReadingPort, useThreadChatReadingPort } from '@/components/thread-chat/useThreadChatReadingPort';
import { useChatHistory } from '@/hooks/useChatHistory';
import { useChatStore } from '@/stores/chatStore';

const threadId = 'return-hover';
useChatStore.getState().setCurrentThread(threadId);

function Reader({ bridge, openSettings }: { bridge: SettingsReadingBridge; openSettings: () => void }) {
  const history = useChatHistory(threadId);
  const register = useCallback(
    (port: ChatReadingPort) => bridge.registerReadingPort(port, () => 'Hover reading'),
    [bridge],
  );
  useThreadChatReadingPort(threadId, 'conversation', register, history);
  return (
    <>
      <button type="button" onClick={openSettings}>
        Open Settings
      </button>
      <main
        data-testid="reading"
        data-loading={String(history.isLoadingHistory)}
        ref={history.scrollContainerRef}
        onScroll={history.handleScroll}
        style={{ height: 360, width: 600, overflow: 'auto', overflowAnchor: 'none', marginTop: 20 }}
      >
        {history.messages.map((message) => (
          <article
            key={message.id}
            data-message-viewport-id={message.id}
            style={{ height: 180, boxSizing: 'border-box', borderBottom: '1px solid gray', padding: 20 }}
          >
            <div data-message-id={message.id}>{message.content}</div>
          </article>
        ))}
        <div ref={history.messagesEndRef} />
      </main>
    </>
  );
}

function App() {
  const [pathname, setPathname] = useState(`/thread/${threadId}`);
  const [bridge] = useState(() => new SettingsReadingBridge(setPathname, 'return-hover-fixture'));
  const view = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
  useLayoutEffect(() => bridge.setRoute(pathname, true), [bridge, pathname]);
  useEffect(() => () => bridge.dispose(), [bridge]);
  return (
    <>
      <output
        data-testid="return-state"
        data-returning={String(view.returning)}
        data-source={String(view.source !== null)}
        data-notice={view.notice ?? ''}
      >
        {view.notice ?? (view.returning ? 'Returning' : 'Ready')}
      </output>
      {pathname === '/settings' ? (
        <button
          type="button"
          onClick={() => {
            if (view.source) void bridge.returnToSource(view.source.id);
          }}
        >
          Return to conversation
        </button>
      ) : (
        <Reader
          bridge={bridge}
          openSettings={() => {
            bridge.captureBeforeSettings();
            setPathname('/settings');
          }}
        />
      )}
    </>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <ThreadChatHistoryAdmissionProvider>
    <App />
  </ThreadChatHistoryAdmissionProvider>,
);
