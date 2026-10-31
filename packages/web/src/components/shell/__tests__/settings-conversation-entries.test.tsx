import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatCommands } from '@/hooks/useChatCommands';
import { apiFetch } from '@/utils/api-client';
import { captureChatReadingRef } from '@/utils/chat-scroll-memory';
import { CallbackAuthCatAvatar } from '../../CallbackAuthCatAvatar';
import { ChatContainerHeader } from '../../ChatContainerHeader';
import { CallbackAuthFailureBlock } from '../../rich/CallbackAuthFailureBlock';
import type { ChatReadingPort } from '../../thread-chat/useThreadChatReadingPort';
import { readSettingsReadingSession } from '../settings-reading-session';
import { SettingsSourceReturnProvider, useSettingsReadingPort } from '../useSettingsSourceReturn';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push }) }));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: [] }) }));
vi.mock('@/hooks/useCatNameResolver', () => ({
  useCatTechnicalLabelResolver: () => () => 'Cat',
  useCatNameResolver: () => () => 'Cat',
}));
vi.mock('@/stores/callbackAuthStore', () => ({
  useCallbackAuthByCat: () => ({ status: 'broken', failures24h: 1 }),
  useCallbackAuthAggregate: () => ({ topReasons: [], topTools: [] }),
  useCallbackAuthAvailable: () => true,
}));
vi.mock('../../CatAvatar', () => ({
  CatAvatar: ({ onCallbackAuthClick }: { onCallbackAuthClick: () => void }) => (
    <button type="button" onClick={onCallbackAuthClick}>
      Auth details
    </button>
  ),
}));
vi.mock('../../ThreadIndicator', () => ({ ThreadIndicator: () => null }));
vi.mock('../../ThreadCatPill', () => ({ ThreadCatPill: () => null }));
vi.mock('../../execution-row/ThreadTitleResetMenu', () => ({ ThreadTitleResetMenu: () => null }));
vi.mock('../HeaderCounts', () => ({ ThreadTasksButton: () => null, ThreadWorksButton: () => null }));

const port: ChatReadingPort = {
  threadId: 'origin',
  ownerId: 'original-reader',
  captureReadingRef: () =>
    captureChatReadingRef({
      threadId: 'origin',
      position: { top: 320, anchor: 'offset', messageAnchor: { messageId: 'm', viewportOffsetPx: 42 } },
    }),
  restoreReadingRef: async () => ({ status: 'unavailable' }),
  releaseReadingRef: () => true,
  navigateToMessage: async () => ({ status: 'unavailable' }),
};
function OriginalReader() {
  const register = useSettingsReadingPort('Actual conversation');
  useEffect(() => register(port), [register]);
  return null;
}
function Command() {
  const { processCommand } = useChatCommands();
  return (
    <button type="button" onClick={() => void processCommand('/config')}>
      Config command
    </button>
  );
}
const entries = [
  { name: '/config', path: '/settings?s=system', text: 'Config command', element: <Command /> },
  {
    name: 'daemon',
    path: '/settings?s=ops&ops=agent-sessions',
    text: 'daemon123',
    element: (
      <ChatContainerHeader
        sidebarOpen
        onToggleSidebar={() => {}}
        threadId="origin"
        viewMode="single"
        onToggleViewMode={() => {}}
        statusPanelOpen={false}
        onToggleStatusPanel={() => {}}
      />
    ),
  },
  {
    name: 'callback failure card',
    path: '/settings?s=ops&ops=observability&obs=callback-auth',
    text: '详情',
    element: (
      <CallbackAuthFailureBlock
        block={{
          id: 'auth',
          title: 'Callback auth failure',
          kind: 'card',
          v: 1,
          meta: {
            kind: 'callback_auth_failure',
            reason: 'expired',
            tool: 'callback',
            catId: 'codex61-sol',
            threadId: 'origin',
            userId: 'owner',
            failedAt: 0,
            fallbackOk: false,
          },
        }}
      />
    ),
  },
  {
    name: 'callback avatar',
    path: '/settings?s=ops&ops=observability&obs=callback-auth',
    text: 'Auth details',
    element: <CallbackAuthCatAvatar catId="codex61-sol" />,
  },
];

describe('actual conversation Settings entrances capture through the original reading owner', () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    localStorage.clear();
    nav.push.mockReset();
    vi.mocked(apiFetch).mockResolvedValue(Response.json({ daemonShortId: 'daemon123' }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });
  it.each(entries)('$name captures its current conversation before navigating', async ({ path, text, element }) => {
    await act(async () =>
      root.render(
        <SettingsSourceReturnProvider pathname="/thread/origin" enabled>
          <OriginalReader />
          {element}
        </SettingsSourceReturnProvider>,
      ),
    );
    const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.trim() === text);
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(nav.push).toHaveBeenCalledWith(path);
    expect(readSettingsReadingSession()).toEqual(
      expect.objectContaining({
        threadId: 'origin',
        label: 'Actual conversation',
        readingRef: expect.stringContaining('chat-reading:origin:'),
      }),
    );
  });
  it.each(entries)('$name keeps classic navigation without activating a new association', async ({
    path,
    text,
    element,
  }) => {
    await act(async () =>
      root.render(
        <SettingsSourceReturnProvider pathname="/thread/origin" enabled={false}>
          <OriginalReader />
          {element}
        </SettingsSourceReturnProvider>,
      ),
    );
    const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.trim() === text);
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(nav.push).toHaveBeenCalledWith(path);
    expect(readSettingsReadingSession()).toBeNull();
  });
});
