import type { ContentModificationDetailView, ContextAttachment } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextMessageRequestStatus } from '../TextMessageRequestStatus';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), push: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mocks.fetch(...args) }));
vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({
  pushThreadRouteWithHistory: (...args: unknown[]) => mocks.push(...args),
}));

const NOW = Date.parse('2026-10-05T12:00:00Z');
const REVISION = `sha256:${'a'.repeat(64)}` as const;
const quote = (id: string): ContextAttachment =>
  ({
    v: 1,
    id,
    kind: 'quote',
    text: `words ${id}`,
    selectionStart: 0,
    selectionEnd: 5,
    source: { kind: 'workspace_file', path: 'docs/plans/launch-plan.md', worktreeId: 'w1', revision: REVISION },
  }) as ContextAttachment;

type Message = React.ComponentProps<typeof TextMessageRequestStatus>['message'];
const message = (patch: Partial<Message> = {}): Message => ({
  id: 'human-1',
  timestamp: NOW - 1000,
  contentBlocks: [
    { type: 'text', text: '请改这两处' },
    { type: 'context_attachment', attachment: quote('1') },
    { type: 'context_attachment', attachment: quote('2') },
  ],
  ...patch,
});
const oldMessage = () => message({ timestamp: NOW - 3 * 60 * 60 * 1000 });

type Execution = NonNullable<ContentModificationDetailView['execution']>['state'];
interface World {
  /** The request the owner holds for each Human message id, as the by-message read returns it. */
  requests: Record<string, { id: string; cat?: string; sourceMessageId?: string; kind?: string }>;
  execution: Record<string, Execution>;
  cancelled: Set<string>;
  byMessageStatus: number;
  detailStatus: number;
  /** An answer to the by-message read of this message id that waits until the test lets it go. */
  hold: Record<string, Promise<void>>;
}
let world: World;

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const detailOf = (messageId: string): unknown => {
  const item = world.requests[messageId];
  return {
    record: {
      requestId: item.id,
      ownerUserId: 'operator',
      revision: world.cancelled.has(item.id) ? 2 : 1,
      createdAt: 1,
      updatedAt: 1,
      progress: { sourceMessageId: item.sourceMessageId ?? messageId, sourceKind: item.kind ?? 'human_message' },
      payload: { targetCatId: item.cat ?? 'cat-a', threadId: 'execution-thread' },
      control: world.cancelled.has(item.id)
        ? { state: 'cancelled', actorId: 'operator', cancelledAt: 1, receiptRef: 'r', taskResolution: 'preserved' }
        : undefined,
    },
    stage: 'queued',
    candidates: [],
    acceptances: [],
    execution: world.execution[item.id]
      ? { state: world.execution[item.id], messageId: 'carrier', targetCatId: 'cat-a', observedAt: 1, evidenceRef: 'e' }
      : undefined,
  };
};
const byMessageCalls = () => mocks.fetch.mock.calls.filter(([url]) => String(url).includes('/by-message/'));

let root: Root;
let host: HTMLElement;
const render = async (element: React.ReactElement) => {
  await act(async () => {
    root.render(element);
  });
};
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const lines = () => [...host.querySelectorAll('[data-testid="modification-progress"]')];
const names = () => undefined;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
  world = { requests: {}, execution: {}, cancelled: new Set(), byMessageStatus: 200, detailStatus: 200, hold: {} };
  mocks.fetch.mockReset();
  mocks.push.mockReset();
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url);
    const byMessage = /^\/api\/content-modifications\/by-message\/([^/]+)$/.exec(path);
    if (byMessage) {
      const messageId = decodeURIComponent(byMessage[1]);
      await world.hold[messageId];
      if (world.byMessageStatus !== 200) return reply({ error: 'x' }, world.byMessageStatus);
      if (!world.requests[messageId]) return reply({ error: 'not_found' }, 404);
      return reply(detailOf(messageId));
    }
    const id = decodeURIComponent(path.split('/')[3] ?? '');
    const messageId = Object.keys(world.requests).find((key) => world.requests[key].id === id);
    if (!messageId) return reply({ error: 'not_found' }, 404);
    if (path.endsWith('/cancel') && init?.method === 'POST') {
      world.cancelled.add(id);
      return reply(detailOf(messageId));
    }
    if (world.detailStatus !== 200) return reply({ error: 'x' }, world.detailStatus);
    return reply(detailOf(messageId));
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('TextMessageRequestStatus', () => {
  it('shows the live line of the request a cat took over from this very message, with the file and its places', async () => {
    world.requests['human-1'] = { id: 'req-a' };
    world.execution['req-a'] = 'running';
    await render(<TextMessageRequestStatus message={message()} resolveCatName={() => '烁烁'} />);
    expect(lines()).toHaveLength(1);
    expect(lines()[0].getAttribute('data-state')).toBe('working');
    expect(lines()[0].textContent).toContain('修改中 · launch-plan.md 2 处');
    expect(String(byMessageCalls()[0][0])).toBe('/api/content-modifications/by-message/human-1');
    expect(host.querySelector('[data-testid="text-message-request"]')).not.toBeNull();
  });

  it('names the cat that is still to start, by the name the person knows it by', async () => {
    world.requests['human-1'] = { id: 'req-a', cat: 'cat-b' };
    world.execution['req-a'] = 'queued';
    await render(
      <TextMessageRequestStatus message={message()} resolveCatName={(id) => (id === 'cat-b' ? '花花' : undefined)} />,
    );
    expect(lines()[0].textContent).toContain('花花尚未开始处理。');
  });

  it('cancels that request from the conversation, then says the run continues', async () => {
    world.requests['human-1'] = { id: 'req-a' };
    world.execution['req-a'] = 'running';
    await render(<TextMessageRequestStatus message={message()} resolveCatName={names} />);
    const cancel = host.querySelector('button[aria-label="取消修改"]') as HTMLButtonElement;
    await act(async () => cancel.click());
    const post = mocks.fetch.mock.calls.find(([url]) => String(url) === '/api/content-modifications/req-a/cancel');
    expect((post?.[1] as RequestInit | undefined)?.method).toBe('POST');
    expect(lines()[0].getAttribute('data-state')).toBe('cancelled_still_running');
    expect(host.textContent).toContain('取消修改不会停止本轮执行。');
  });

  it('says nothing before a cat has taken the message over, and an old message is read once, not polled', async () => {
    await render(<TextMessageRequestStatus message={oldMessage()} resolveCatName={names} />);
    expect(lines()).toHaveLength(0);
    expect(host.innerHTML).toBe('');
    await advance(60_000);
    expect(byMessageCalls()).toHaveLength(1);
  });

  it('keeps looking for a fresh message until a cat takes it over, then stops looking', async () => {
    await render(<TextMessageRequestStatus message={message()} resolveCatName={names} />);
    expect(byMessageCalls()).toHaveLength(1);
    await advance(4000);
    expect(byMessageCalls()).toHaveLength(2);
    expect(lines()).toHaveLength(0);
    world.requests['human-1'] = { id: 'req-a' };
    world.execution['req-a'] = 'running';
    await advance(4000);
    expect(lines()).toHaveLength(1);
    expect(byMessageCalls()).toHaveLength(3);
    // The owner holds one request per Human message: once it is found there is nothing more to discover.
    await advance(60_000);
    expect(byMessageCalls()).toHaveLength(3);
  });

  it('finds a late request on an old message when the work surface says something changed', async () => {
    await render(<TextMessageRequestStatus message={oldMessage()} resolveCatName={names} />);
    world.requests['human-1'] = { id: 'req-a' };
    world.execution['req-a'] = 'running';
    await act(async () => {
      window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated'));
    });
    expect(lines()).toHaveLength(1);
  });

  it('gives up looking after the window, so a message nobody takes over does not poll forever', async () => {
    await render(<TextMessageRequestStatus message={message()} resolveCatName={names} />);
    await advance(10 * 60 * 1000);
    const seen = byMessageCalls().length;
    await advance(60_000);
    expect(byMessageCalls()).toHaveLength(seen);
    expect(seen).toBeLessThanOrEqual(1 + (10 * 60 * 1000) / 4000);
  });

  it('does not look while the page is hidden', async () => {
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      await render(<TextMessageRequestStatus message={message()} resolveCatName={names} />);
      const first = byMessageCalls().length;
      await advance(20_000);
      expect(byMessageCalls()).toHaveLength(first);
    } finally {
      hidden.mockRestore();
    }
  });

  it.each([
    401, 403, 410,
  ])('says nothing and stops asking when the owner answers %i (not allowed to see it)', async (status) => {
    world.byMessageStatus = status;
    await render(<TextMessageRequestStatus message={message()} resolveCatName={names} />);
    await advance(30_000);
    expect(host.innerHTML).toBe('');
    expect(byMessageCalls()).toHaveLength(1);
  });

  it('a failed read says "cannot tell", never "no request", and reloads on request', async () => {
    world.byMessageStatus = 500;
    await render(<TextMessageRequestStatus message={oldMessage()} resolveCatName={names} />);
    expect(lines()).toHaveLength(1);
    expect(lines()[0].getAttribute('data-state')).toBe('unavailable');
    world.byMessageStatus = 200;
    world.requests['human-1'] = { id: 'req-a' };
    world.execution['req-a'] = 'running';
    await act(async () => (host.querySelector('button[aria-label="重新加载"]') as HTMLButtonElement).click());
    expect(lines()[0].getAttribute('data-state')).toBe('working');
  });

  it('does not take an answer whose own record does not say it came from this Human message', async () => {
    world.requests['human-1'] = { id: 'req-a', sourceMessageId: 'human-9' };
    await render(<TextMessageRequestStatus message={oldMessage()} resolveCatName={names} />);
    expect(lines()).toHaveLength(0);
    world.requests['human-1'] = { id: 'req-a', kind: 'generated_request' };
    await act(async () => {
      window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated'));
    });
    expect(lines()).toHaveLength(0);
  });

  it('asks again for the real id when an optimistic message gets one', async () => {
    world.requests['human-2'] = { id: 'req-b' };
    world.execution['req-b'] = 'running';
    await render(<TextMessageRequestStatus message={message({ id: 'optimistic-1' })} resolveCatName={names} />);
    expect(lines()).toHaveLength(0);
    await render(<TextMessageRequestStatus message={message({ id: 'human-2' })} resolveCatName={names} />);
    expect(lines()).toHaveLength(1);
  });

  it('holds no timer for an old message nobody took over: nothing is polled, so nothing is scheduled', async () => {
    await render(<TextMessageRequestStatus message={oldMessage()} resolveCatName={names} />);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('after the request is found, a focus right after a read is only a hint (throttled); a later one reads again', async () => {
    world.requests['human-1'] = { id: 'req-a' };
    world.execution['req-a'] = 'running';
    await render(<TextMessageRequestStatus message={message()} resolveCatName={names} />);
    expect(byMessageCalls()).toHaveLength(1);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(byMessageCalls()).toHaveLength(1);
    await advance(20_000);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(byMessageCalls()).toHaveLength(2);
  });

  it('shows the request of the message it is given now: another message does not inherit the line', async () => {
    world.requests['human-1'] = { id: 'req-a' };
    world.execution['req-a'] = 'running';
    await render(<TextMessageRequestStatus message={message()} resolveCatName={names} />);
    expect(lines()).toHaveLength(1);
    await render(<TextMessageRequestStatus message={message({ id: 'human-3' })} resolveCatName={names} />);
    expect(lines()).toHaveLength(0);
  });

  it('an answer that was asked for another message and arrives late is dropped, not shown on this one', async () => {
    let release: () => void = () => undefined;
    world.hold['human-1'] = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.requests['human-1'] = { id: 'req-a' };
    world.execution['req-a'] = 'running';
    await render(<TextMessageRequestStatus message={message()} resolveCatName={names} />);
    await render(<TextMessageRequestStatus message={message({ id: 'human-3' })} resolveCatName={names} />);
    await act(async () => release());
    expect(lines()).toHaveLength(0);
  });

  it('reads nothing for a message that quotes no file, an old quote with no version, or a picture', async () => {
    const plain: Message['contentBlocks'] = [{ type: 'text', text: '只有字' }];
    const oldQuote = {
      ...quote('1'),
      source: { kind: 'workspace_file', path: 'a.md', worktreeId: 'w1' },
    } as ContextAttachment;
    for (const contentBlocks of [
      plain,
      [{ type: 'context_attachment', attachment: oldQuote }] as Message['contentBlocks'],
    ]) {
      await render(<TextMessageRequestStatus message={message({ contentBlocks })} resolveCatName={names} />);
      expect(host.innerHTML).toBe('');
    }
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('leaves a message that already carries a request headline to its own presentation', async () => {
    world.requests['human-1'] = { id: 'req-a' };
    await render(
      <TextMessageRequestStatus
        message={message({ extra: { contentModificationRequestV1: { v: 1 } } as Message['extra'] })}
        resolveCatName={names}
      />,
    );
    expect(host.innerHTML).toBe('');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
