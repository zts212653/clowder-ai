import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  pushThread: vi.fn(),
  planTeleport: vi.fn(),
  scrollToMessage: vi.fn(),
  kickTeleportResolve: vi.fn(),
}));

vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({ pushThreadRouteWithHistory: mocks.pushThread }));
vi.mock('@/utils/scrollToMessage', () => ({ scrollToMessage: mocks.scrollToMessage }));
vi.mock('@/utils/teleport', () => ({
  planTeleport: mocks.planTeleport,
  kickTeleportResolve: mocks.kickTeleportResolve,
}));

const { MessageBundleCard } = await import('../MessageBundleCard');

function response(items: unknown[], extra: Record<string, unknown> = {}) {
  return {
    messageBundleId: 'bundle-1',
    targetThreadId: 'target-thread',
    createdBy: 'user-1',
    createdAt: 200,
    sourceThread: { id: 'source-thread', title: 'Source Thread' },
    items,
    ...extra,
  };
}

describe('MessageBundleCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.apiFetch.mockReset();
    mocks.pushThread.mockReset();
    mocks.planTeleport.mockReset();
    mocks.scrollToMessage.mockReset();
    mocks.kickTeleportResolve.mockReset();
    useChatStore.setState({ currentThreadId: 'target-thread' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    React.act(() => root.unmount());
    container.remove();
  });

  async function renderCard() {
    await React.act(async () => {
      root.render(<MessageBundleCard messageId="bundle-1" forwarderName="You" getCatLabel={(id) => `Cat ${id}`} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('renders one Quote compactly and separates the original author from the forwarder comment', async () => {
    mocks.apiFetch.mockResolvedValue(
      new Response(
        JSON.stringify(
          response([
            {
              status: 'available',
              kind: 'quote',
              messageId: 'source-1',
              sourceThreadId: 'source-thread',
              author: { kind: 'cat', catId: 'opus' },
              timestamp: 100,
              readableContent: 'quoted source text',
              comment: 'forwarder comment',
            },
          ]),
        ),
        { status: 200 },
      ),
    );

    await renderCard();

    expect(container.textContent).toContain('来自「Source Thread」');
    expect(container.textContent).toContain('Cat opus');
    expect(container.textContent).toContain('quoted source text');
    expect(container.textContent).toContain('You 的点评');
    expect(container.textContent).toContain('forwarder comment');
    expect(container.textContent).not.toContain('1 条聊天记录');
    expect(container.querySelector('button[aria-expanded]')).toBeNull();
  });

  it('renders one whole message directly instead of folding a one-item card', async () => {
    mocks.apiFetch.mockResolvedValue(
      new Response(
        JSON.stringify(
          response([
            {
              status: 'available',
              kind: 'message',
              messageId: 'source-1',
              sourceThreadId: 'source-thread',
              author: { kind: 'cat', catId: 'opus' },
              timestamp: 100,
              readableContent: 'one whole source message',
            },
          ]),
        ),
        { status: 200 },
      ),
    );

    await renderCard();

    expect(container.textContent).toContain('one whole source message');
    expect(container.querySelector('button[aria-expanded]')).toBeNull();
  });

  it('keeps the bundle note distinct from an item-level comment', async () => {
    mocks.apiFetch.mockResolvedValue(
      new Response(
        JSON.stringify(
          response(
            [
              {
                status: 'available',
                kind: 'quote',
                messageId: 'source-1',
                sourceThreadId: 'source-thread',
                author: { kind: 'cat', catId: 'opus' },
                timestamp: 100,
                readableContent: 'source',
                comment: 'why this exact quote matters',
              },
            ],
            { note: 'overall forwarding context' },
          ),
        ),
        { status: 200 },
      ),
    );

    await renderCard();

    expect(container.querySelector('[data-message-bundle-note]')?.textContent).toContain('You 的留言');
    expect(container.querySelector('[data-message-bundle-note]')?.textContent).toContain('overall forwarding context');
    expect(container.querySelector('[data-message-bundle-note]')?.textContent).not.toContain(
      'why this exact quote matters',
    );
    expect(container.textContent).toContain('You 的点评');
  });

  it('renders the one selected Rich Block as an inert forwarded artifact', async () => {
    mocks.apiFetch.mockResolvedValue(
      new Response(
        JSON.stringify(
          response([
            {
              status: 'available',
              kind: 'rich_block',
              messageId: 'source-1',
              sourceThreadId: 'source-thread',
              author: { kind: 'cat', catId: 'opus' },
              timestamp: 100,
              readableContent: 'Approval\nApprove now',
              richBlock: {
                id: 'block-1',
                kind: 'card',
                v: 1,
                title: 'Approval',
                bodyMarkdown: 'Evidence only',
                actions: [{ label: 'Approve now', action: 'approve' }],
              },
            },
          ]),
        ),
        { status: 200 },
      ),
    );

    await renderCard();

    expect(container.querySelector('[data-forwarded-rich-block="block-1"]')).not.toBeNull();
    expect(container.textContent).toContain('Evidence only');
    expect(
      Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Approve now'),
    ).toBe(false);
  });

  it('folds multiple messages, summarizes participants, and expands a shared tombstone state', async () => {
    mocks.apiFetch.mockResolvedValue(
      new Response(
        JSON.stringify(
          response([
            {
              status: 'available',
              kind: 'message',
              messageId: 'source-1',
              sourceThreadId: 'source-thread',
              author: { kind: 'cat', catId: 'opus' },
              timestamp: 100,
              readableContent: 'visible source',
            },
            { status: 'tombstone', messageId: 'source-2', reason: 'source_unavailable' },
          ]),
        ),
        { status: 200 },
      ),
    );

    await renderCard();

    expect(container.textContent).toContain('2 条聊天记录');
    expect(container.textContent).toContain('由 You 转发');
    expect(container.textContent).toContain('Cat opus');
    expect(container.textContent).not.toContain('visible source');
    await React.act(async () => {
      (container.querySelector('button[aria-expanded="false"]') as HTMLButtonElement).click();
    });
    expect(container.textContent).toContain('visible source');
    expect(container.textContent).toContain('原消息已删除、撤回或不可见');
    expect(container.querySelector('[data-bundle-tombstone="source_unavailable"]')).not.toBeNull();
  });

  it('shows a durable inline error and retries without losing the Bundle identity', async () => {
    mocks.apiFetch
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(response([])), { status: 200 }));

    await renderCard();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await React.act(async () => {
      (
        Array.from(container.querySelectorAll('button')).find(
          (button) => button.textContent === '重试',
        ) as HTMLButtonElement
      ).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-message-bundle-id="bundle-1"]')).not.toBeNull();
  });

  it('uses exact source coordinates when the user opens an item', async () => {
    mocks.apiFetch.mockResolvedValue(
      new Response(
        JSON.stringify(
          response([
            {
              status: 'available',
              kind: 'quote',
              messageId: 'source-1',
              sourceThreadId: 'source-thread',
              author: { kind: 'cat', catId: 'opus' },
              timestamp: 100,
              readableContent: 'source',
            },
          ]),
        ),
        { status: 200 },
      ),
    );
    mocks.planTeleport.mockReturnValue({ scrollNow: null, navigateTo: 'source-thread' });

    await renderCard();
    React.act(() => (container.querySelector('button[aria-label="查看来源消息 1"]') as HTMLButtonElement).click());

    expect(mocks.planTeleport).toHaveBeenCalledWith({
      threadId: 'source-thread',
      messageId: 'source-1',
      currentThreadId: 'target-thread',
    });
    expect(mocks.pushThread).toHaveBeenCalledWith('source-thread', window);
  });
});
