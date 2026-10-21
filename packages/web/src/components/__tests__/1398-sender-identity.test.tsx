import type { ConnectorSource, MessageFrom } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { resolveMessageSender } from '@/lib/resolve-sender';
import type { ChatMessage as Message } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { AppendedInputReceipts } from '../AppendedInputReceipts';
import { ChatMessage } from '../ChatMessage';
import { ConnectorBubble } from '../ConnectorBubble';
import { MessageNavigator } from '../MessageNavigator';
import { SortableQueueEntryRow } from '../QueueEntryRow';
import { ReplyPill } from '../ReplyPill';
import { ReplyPreviewBar } from '../ReplyPreviewBar';

Object.assign(globalThis, { React });
vi.mock('@/hooks/useCoCreatorConfig', () => ({
  useCoCreatorConfig: () => ({
    name: 'lang',
    avatar: '/human.png',
    aliases: [],
    mentionPatterns: [],
    color: { primary: '#123456', secondary: '#eeeeee' },
  }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(() => new Promise(() => undefined)) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
const member = {
  id: 'cat-1',
  displayName: 'Member One',
  avatar: '/member.png',
  color: { primary: '#123789', secondary: '#eeeeee' },
} as CatData;
const getCatById = (id: string) => (id === member.id ? member : undefined);
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById, cats: [member] }),
  formatCatName: (cat: CatData) => cat.displayName,
}));
const identity = {
  from: { kind: 'external' as const, connectorId: 'scheduler' },
  source: { connector: 'scheduler', label: '定时任务', icon: 'scheduler' },
};
afterEach(() => useChatStore.setState({ currentThreadId: '', messages: [], replyToMessage: null }));

describe('1398 canonical sender identity across Queue and reply surfaces', () => {
  it.each([
    { from: { kind: 'user', userId: 'owner' }, type: 'user', image: '/human.png', color: '#123456' },
    { from: { kind: 'agent', catId: 'cat-1' }, type: 'assistant', image: '/member.png', color: '#123789' },
    {
      from: { kind: 'plugin', instanceId: 'pi-image' },
      type: 'connector',
      image: '/api/plugin-manager/plugins/example.chat/icon',
      color: '#07c160',
    },
  ] as const)('uses the same full-size member avatar for $type messages', ({ from, type, image, color }) => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={{
          id: 'member-body',
          type,
          from,
          content: 'Hello',
          timestamp: 100,
          ...(from.kind === 'agent' ? { catId: from.catId } : {}),
          ...(from.kind === 'plugin'
            ? { source: { connector: 'custom-chat', label: 'Example Chat', icon: image, themeColor: color } }
            : {}),
        }}
        getCatById={getCatById}
      />,
    );
    const container = document.createElement('div');
    container.innerHTML = html;
    const frame = container.querySelector('[data-sender-avatar="message"]') as HTMLElement;
    expect(frame).not.toBeNull();
    expect(frame.classList.contains('w-8')).toBe(true);
    expect(frame.classList.contains('h-8')).toBe(true);
    expect(frame.style.boxShadow).toBe('');
    const ring = frame.querySelector('[data-member-avatar-ring]') as HTMLElement;
    expect(ring.style.boxShadow).toBe(`inset 0 0 0 1px ${color}`);
    const avatar = frame.querySelector('img') as HTMLImageElement;
    expect(avatar.getAttribute('src')).toBe(image);
    expect(avatar.classList.contains('w-full')).toBe(true);
    expect(avatar.classList.contains('h-full')).toBe(true);
    expect(frame.parentElement?.closest('[style*="box-shadow"]')).toBeNull();
  });

  it.each([
    'user',
    'agent',
    'plugin',
  ] as const)('keeps the shared frame when a %s avatar fails to load', async (kind) => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const from: MessageFrom =
      kind === 'user'
        ? { kind, userId: 'owner' }
        : kind === 'agent'
          ? { kind, catId: member.id }
          : { kind, instanceId: 'pi-avatar' };
    const onEdit = vi.fn();
    await act(async () =>
      root.render(
        <ChatMessage
          message={{
            id: 'failed-image',
            from,
            type: kind === 'user' ? 'user' : kind === 'agent' ? 'assistant' : 'connector',
            catId: kind === 'agent' ? member.id : undefined,
            content: 'Hello',
            timestamp: 100,
            source: kind === 'plugin' ? { connector: 'custom-chat', label: 'Chat', icon: '/missing.png' } : undefined,
          }}
          getCatById={getCatById}
          onEditCat={onEdit}
          onEditCoCreator={onEdit}
        />,
      ),
    );
    const frame = host.querySelector('[data-sender-avatar="message"]') as HTMLElement;
    const img = frame.querySelector('img') as HTMLImageElement;
    await act(async () => img.dispatchEvent(new Event('error')));
    expect(img.src).toMatch(/^data:image\/svg\+xml;base64,/u);
    expect(host.querySelector('[data-sender-avatar="message"]')).toBe(frame);
    expect(img.className).toContain('w-full h-full');
    if (kind !== 'plugin') {
      await act(async () => frame.click());
      expect(onEdit).toHaveBeenCalledOnce();
    }
    await act(async () => root.unmount());
  });

  it('uses the same member frame for a symbolic connector and ordinary fallback color', () => {
    const html = renderToStaticMarkup(
      <ConnectorBubble
        message={{
          id: 'symbol',
          type: 'connector',
          content: 'Hello',
          timestamp: 100,
          from: { kind: 'plugin', instanceId: 'pi-symbol' },
          source: { connector: 'custom-symbol', label: 'Symbol Bot', icon: 'message' },
        }}
      />,
    );
    const container = document.createElement('div');
    container.innerHTML = html;
    const frame = container.querySelector('[data-sender-avatar="message"]') as HTMLElement;
    expect(frame).not.toBeNull();
    expect((frame.querySelector('[data-member-avatar-ring]') as HTMLElement).style.boxShadow).toBe(
      'inset 0 0 0 1px #64748B',
    );
    expect(frame.querySelector('svg')).not.toBeNull();
    expect(frame.querySelector('img')).toBeNull();
  });

  it('shows plugin package identity and declared color without an opaque routing ID', () => {
    const input = {
      from: { kind: 'plugin' as const, instanceId: 'pi-chat' },
      source: {
        connector: 'custom-chat',
        label: 'Example Chat',
        icon: '/api/plugin-manager/plugins/example.chat/icon',
        themeColor: '#07c160',
        sender: { id: 'opaque@provider' },
      },
    };
    const sender = resolveMessageSender(input, getCatById, { name: 'lang', aliases: [], mentionPatterns: [] });
    expect(sender.label).toBe('Example Chat');
    expect(sender.color).toBe('#07c160');
    const html = renderToStaticMarkup(
      <ReplyPill
        replyPreview={{ ...input, senderCatId: null, content: 'Hi' }}
        replyToId="source"
        getCatById={() => undefined}
      />,
    );
    expect(html).toContain('/api/plugin-manager/plugins/example.chat/icon');
    expect(html).not.toContain('opaque@provider');
    const bubble = renderToStaticMarkup(
      <ConnectorBubble
        message={{ ...input, id: 'plugin-message', type: 'connector', content: 'Hello', timestamp: 100 } as Message}
      />,
    );
    expect(bubble).toContain('color:#07c160');
    expect(bubble).toContain('background-color:color-mix(in srgb, #07c160 10%, var(--cafe-surface))');
    expect(bubble).not.toContain('opaque@provider');
  });

  it('quotes 定时任务 with its own name and registry icon, never as the operator', () => {
    const html = renderToStaticMarkup(
      <ReplyPill
        replyPreview={{ senderCatId: null, content: 'CI finished', ...identity }}
        replyToId="source"
        getCatById={() => undefined}
      />,
    );
    expect(html).toContain('定时任务');
    expect(html).not.toContain('lang');
    expect(html).toContain('<svg');
  });
  it('renders plugin message icons and sender names without changing the plugin identity', () => {
    const input = {
      from: { kind: 'plugin' as const, instanceId: 'wechat-instance' },
      source: { connector: 'wechat-plugin', label: 'WeChat', icon: 'message', sender: { id: 'alice', name: 'Alice' } },
    };
    const sender = resolveMessageSender(input, getCatById, { name: 'lang', aliases: [], mentionPatterns: [] });
    expect(sender.label).toBe('WeChat · Alice');
    expect(sender.isCoCreator).toBe(false);
    const html = renderToStaticMarkup(
      <ReplyPill
        replyPreview={{ ...input, senderCatId: null, content: 'Hi' }}
        replyToId="source"
        getCatById={() => undefined}
      />,
    );
    expect(html).toContain('<svg');
    expect(html).not.toContain('>message<');
    expect(input.from).toEqual({ kind: 'plugin', instanceId: 'wechat-instance' });
  });
  it('uses the same identity in the input reply preview', () => {
    const html = renderToStaticMarkup(
      <ReplyPreviewBar
        replyToMessage={{ id: 'source', senderCatId: null, content: 'CI finished', ...identity }}
        cats={[]}
        onClear={() => {}}
      />,
    );
    expect(html).toContain('定时任务');
    expect(html).not.toContain('lang');
  });
  it('renders a queued external source with its connector icon rather than a generic cat avatar', () => {
    const html = renderToStaticMarkup(
      <SortableQueueEntryRow
        key="queue"
        entry={{
          id: 'q',
          threadId: 't',
          userId: 'owner',
          content: 'CI finished',
          messageId: 'source',
          mergedMessageIds: [],
          from: identity.from,
          targetCats: [],
          intent: 'execute',
          status: 'queued',
          createdAt: 1,
        }}
        index={0}
        imageCount={0}
        ownerName="lang"
        deliveredTargetIds={[]}
        resolveCatName={(id) => id}
        resolveCatAvatar={() => undefined}
        onRemove={() => {}}
        onRecallEdit={() => {}}
        onSteer={() => {}}
      />,
    );
    const route = html.slice(html.indexOf('data-testid="queue-route-q"'));
    expect(route).toContain('定时任务');
    expect(route).toContain('<svg');
    expect(route).not.toContain('<img');
  });
  it('does not assign an unloaded or unknown reference to the operator', () => {
    const html = renderToStaticMarkup(
      <ReplyPreviewBar
        replyToMessage={{ id: 'missing', senderCatId: null, content: '(原消息未加载)' }}
        cats={[]}
        onClear={() => {}}
      />,
    );
    expect(html).not.toContain('lang');
  });
  const cases: { name: string; from: MessageFrom; source?: ConnectorSource; label: string }[] = [
    { name: 'github', ...identity, label: '定时任务' },
    {
      name: 'named external actor',
      from: { kind: 'external', connectorId: 'custom', sender: { id: 'actor', name: 'Alice' } },
      source: { connector: 'custom', label: 'Team Room', icon: '🧩' },
      label: 'Team Room · Alice',
    },
    {
      name: 'custom source',
      from: { kind: 'external', connectorId: 'custom' },
      source: { connector: 'custom', label: 'Custom Feed', icon: '🧩' },
      label: 'Custom Feed',
    },
    { name: 'unregistered source', from: { kind: 'external', connectorId: 'unregistered' }, label: 'unregistered' },
    { name: 'plugin', from: { kind: 'plugin', instanceId: 'plugin-instance' }, label: '插件' },
    { name: 'system', from: { kind: 'system', service: 'system-service' }, label: 'system-service' },
    { name: 'user', from: { kind: 'user', userId: 'owner' }, label: 'lang' },
    { name: 'agent', from: { kind: 'agent', catId: member.id }, label: 'Member One' },
  ];
  it.each(cases)('$name retains the same identity through body, Queue, reply and JSON refresh', ({
    from,
    source,
    label,
  }) => {
    const input = JSON.parse(JSON.stringify({ from, source }));
    const sender = resolveMessageSender(input, getCatById, {
      name: 'lang',
      aliases: [],
      mentionPatterns: [],
      color: { primary: '#123456', secondary: '#eeeeee' },
    });
    expect(sender.label).toBe(label);
    const preview = { ...input, senderCatId: null, content: 'content' };
    for (const node of [
      <ReplyPill key="pill" replyPreview={preview} replyToId="source" getCatById={getCatById} />,
      <ReplyPreviewBar key="bar" replyToMessage={{ ...preview, id: 'source' }} cats={[member]} onClear={() => {}} />,
      <SortableQueueEntryRow
        key="queue"
        entry={{
          id: 'matrix',
          threadId: 't',
          userId: 'owner',
          content: 'content',
          messageId: 'source',
          mergedMessageIds: [],
          from,
          messagePreview: { source },
          targetCats: [],
          intent: 'execute',
          status: 'queued',
          createdAt: 1,
        }}
        index={0}
        imageCount={0}
        ownerName="lang"
        deliveredTargetIds={[]}
        resolveCatName={(id) => id}
        resolveCatAvatar={() => undefined}
        onRemove={() => {}}
        onRecallEdit={() => {}}
        onSteer={() => {}}
      />,
      <ChatMessage
        key="body"
        message={{
          id: 'source',
          type: from.kind === 'user' ? 'user' : from.kind === 'agent' ? 'assistant' : 'connector',
          catId: from.kind === 'agent' ? from.catId : undefined,
          content: 'content',
          timestamp: 1,
          ...input,
        }}
        getCatById={getCatById}
      />,
    ]) {
      expect(renderToStaticMarkup(node)).toContain(label);
    }
    const canonical = {
      id: 'source',
      type:
        from.kind === 'user'
          ? ('user' as const)
          : from.kind === 'agent'
            ? ('assistant' as const)
            : ('connector' as const),
      ...(from.kind === 'agent' ? { catId: from.catId } : {}),
      content: 'content',
      timestamp: 2,
      ...input,
    };
    const navHtml = renderToStaticMarkup(
      <MessageNavigator
        messages={[canonical, { ...canonical, id: 'source-2' }, { ...canonical, id: 'source-3' }]}
        scrollContainerRef={{ current: null }}
        onJumpToMessage={() => false}
        beginUserScroll={() => null}
      />,
    );
    expect(navHtml).toContain(label);
    expect(navHtml).toContain(sender.color);
    const receiptHtml = renderToStaticMarkup(
      <AppendedInputReceipts
        response={{
          id: 'response',
          type: 'assistant',
          content: 'answer',
          timestamp: 1,
          lifecycle: {
            kind: 'response',
            orderKey: '1:response',
            status: 'processing',
            invocationId: 'invocation',
            targetId: member.id,
            inputEntryIds: ['first', 'append'],
            inputMessageIds: ['first', 'source'],
            startedAt: 1,
          },
        }}
        timelineMessages={[canonical]}
        getCatById={getCatById}
      />,
    );
    expect(receiptHtml).toContain(label);
  });
  it('uses canonical actor and rejects display metadata belonging to another identity', () => {
    const sender = resolveMessageSender(
      {
        from: identity.from,
        source: { connector: 'impostor', label: 'lang', icon: '/human.png', sender: { id: 'wrong', name: 'lang' } },
      },
      getCatById,
      { name: 'lang', aliases: [], mentionPatterns: [] },
    );
    expect(sender.label).toBe('定时任务');
    expect(sender.fallbackIcon).toBeUndefined();
  });
  it('does not use legacy catId or source to guess an absent from', () => {
    expect(
      resolveMessageSender({ source: identity.source }, getCatById, { name: 'lang', aliases: [], mentionPatterns: [] })
        .label,
    ).toBe('未知来源');
  });
  it('restores the quoted identity after the canonical parent arrives, without borrowing another thread', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const draft = { id: 'source', threadId: 't', senderCatId: null, content: 'restored draft' };
    useChatStore.setState({ currentThreadId: 't', messages: [] });
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    try {
      act(() => root.render(<ReplyPreviewBar replyToMessage={draft} cats={[]} onClear={() => {}} />));
      expect(container.textContent).toContain('未知来源');
      act(() =>
        useChatStore.setState({
          messages: [{ id: 'source', type: 'connector', content: 'content', timestamp: 1, ...identity } as Message],
        }),
      );
      expect(container.textContent).toContain('定时任务');
      expect(container.textContent).not.toContain('lang');
      useChatStore.getState().setReplyTo(draft);
      expect(useChatStore.getState().replyToMessage?.from).toEqual(identity.from);
      act(() =>
        useChatStore.setState({
          currentThreadId: 'other',
          messages: [
            { id: 'source', type: 'user', from: { kind: 'user', userId: 'owner' }, content: 'other', timestamp: 1 },
          ],
        }),
      );
      expect(container.textContent).not.toContain('lang');
    } finally {
      act(() => root.unmount());
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });
});
