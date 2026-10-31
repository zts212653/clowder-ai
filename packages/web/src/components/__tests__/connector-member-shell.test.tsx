import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import type { ChatMessage as Message } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ChatMessage } from '../ChatMessage';
import { SHELL_PRESENTATION_STORAGE_KEY } from '../shell/shell-presentation';

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
vi.mock('@/hooks/useCoCreatorConfig', () => ({
  useCoCreatorConfig: () => ({
    name: 'lang',
    aliases: [],
    mentionPatterns: [],
    color: { primary: '#B05F45', secondary: '#eeeeee' },
  }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(() => new Promise(() => undefined)) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const member = {
  id: 'codex',
  displayName: 'Maine Coon',
  color: { primary: '#659D62', secondary: '#eeeeee' },
} as CatData;
const getCatById = (id: string) => (id === member.id ? member : undefined);
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById, cats: [member] }),
  formatCatName: (cat: CatData) => cat.displayName,
}));

function plugin(overrides: Partial<Message> = {}): Message {
  return {
    id: 'plugin-message',
    type: 'connector',
    from: { kind: 'plugin', instanceId: 'github-instance' },
    source: {
      connector: 'github-operations',
      label: 'GitHub Operations',
      icon: '/api/plugin-manager/plugins/github/icon',
      themeColor: '#b33fc0',
    },
    content: 'PR update',
    timestamp: 100,
    ...overrides,
  };
}

function external(overrides: Partial<Message> = {}): Message {
  return {
    id: 'external-message',
    type: 'connector',
    from: { kind: 'external', connectorId: 'feishu', sender: { id: 'ou-alice', name: 'Alice' } },
    source: { connector: 'feishu', label: 'Feishu', icon: 'message', themeColor: '#3377cc' },
    content: 'External input',
    timestamp: 101,
    ...overrides,
  };
}

describe('plugin and external messages use the truthful member shell', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'v2');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useChatStore.setState({ currentThreadId: 'thread-1', messages: [], threads: [], isLoadingThreads: false });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.clear();
    useChatStore.setState({ currentThreadId: '', messages: [] });
  });

  function render(message: Message, timelineMessages: readonly Message[] = [message]) {
    act(() =>
      root.render(
        <ChatMessage
          message={message}
          threadId="thread-1"
          timelineMessages={timelineMessages}
          getCatById={getCatById}
        />,
      ),
    );
  }

  it('keeps plugin colour inside a rounded-square icon and uses a neutral plate, role and body rule', () => {
    render(plugin());
    const plate = container.querySelector('[data-testid="member-nameplate"]') as HTMLElement;
    const name = plate.querySelector('[data-testid="cat-nameplate-name"]') as HTMLElement;
    const avatar = plate.querySelector('[data-sender-avatar="nameplate"]') as HTMLElement;
    const body = container.querySelector('[data-testid="message-bubble"]') as HTMLElement;

    expect(name.textContent).toBe('GitHub Operations');
    expect(name.style.color).toBe('var(--shell-body)');
    expect(plate.style.backgroundImage).toContain('var(--shell-selected)');
    expect(container.querySelector('[data-sender-role]')?.textContent).toBe('Plugin');
    expect(avatar.dataset.senderAvatarShape).toBe('rounded-square');
    expect(avatar.style.color).toBe('rgb(179, 63, 192)');
    expect(body.style.borderLeftColor).toBe('var(--shell-hairline)');
    expect(body.style.borderLeftWidth).toBe('3px');
  });

  it('shows an external person as themselves with a platform role instead of connector identity', () => {
    render(external());
    const plate = container.querySelector('[data-testid="member-nameplate"]') as HTMLElement;
    expect(plate.querySelector('[data-testid="cat-nameplate-name"]')?.textContent).toBe('Alice');
    expect(container.querySelector('[data-sender-role]')?.textContent).toBe('External · Feishu');
    expect(container.textContent).not.toContain('Feishu · Alice');
    const avatar = plate.querySelector('[data-sender-avatar="nameplate"]') as HTMLElement;
    expect(avatar.dataset.senderAvatarShape).toBe('round');
    expect(avatar.style.color).toBe('var(--shell-body)');
  });

  it('preserves an external sender ID when the platform provides no display name', () => {
    render(
      external({
        from: { kind: 'external', connectorId: 'feishu', sender: { id: 'ou-id-only' } },
      }),
    );
    expect(container.querySelector('[data-testid="cat-nameplate-name"]')?.textContent).toBe('ou-id-only');
    expect(container.querySelector('[data-sender-role]')?.textContent).toBe('External · Feishu');
    expect(container.textContent).not.toContain('Host');
  });

  it('labels a connector-owned Host message by purpose', () => {
    render(
      external({
        id: 'host-hold',
        from: { kind: 'external', connectorId: 'hold-ball' },
        source: { connector: 'hold-ball', label: '等待中', icon: 'timer' },
      }),
    );
    expect(container.querySelector('[data-testid="cat-nameplate-name"]')?.textContent).toBe('等待中');
    expect(container.querySelector('[data-sender-role]')?.textContent).toBe('Host');
  });

  it('renders an incoming plugin reply with the exact authorized parent preview', () => {
    const parent: Message = {
      id: 'parent',
      type: 'user',
      from: { kind: 'user', userId: 'owner' },
      content: 'Exact parent body',
      timestamp: 90,
    };
    const reply = plugin({
      replyTo: parent.id,
      replyPreview: { from: parent.from, senderCatId: null, content: 'Parent summary' },
    });
    render(reply, [parent, reply]);
    const reference = container.querySelector('button[title="lang: Parent summary"]');
    expect(reference?.textContent).toContain('Parent summary');
    expect(reference?.closest('[data-message-author-row]')).not.toBeNull();
  });

  it('keeps plugin identity when a member replies to a plugin message', () => {
    const parent = plugin({ content: 'Plugin result' });
    const reply: Message = {
      id: 'member-reply',
      type: 'assistant',
      from: { kind: 'agent', catId: member.id },
      catId: member.id,
      content: 'Acknowledged',
      timestamp: 110,
      replyTo: parent.id,
      replyPreview: {
        from: parent.from,
        source: parent.source,
        senderCatId: null,
        content: 'Plugin result',
      },
    };
    render(reply, [parent, reply]);
    const reference = container.querySelector('button[title="GitHub Operations: Plugin result"]');
    expect(reference?.textContent).toContain('GitHub Operations');
  });
});
