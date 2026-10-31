import type { ContentModificationDetailView, MediaContextAttachment } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaMessageRequestStatus } from '../MediaMessageRequestStatus';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), push: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mocks.fetch(...args) }));
vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({
  pushThreadRouteWithHistory: (...args: unknown[]) => mocks.push(...args),
}));

const NOW = Date.parse('2026-10-03T12:00:00Z');
const CONTEXT = '/api/content-modifications/context';
const media: MediaContextAttachment = {
  v: 1,
  id: 'media-1',
  kind: 'media',
  title: '窄屏设计稿.png',
  mediaType: 'image/png',
  source: {
    kind: 'workspace',
    locator: { worktreeId: 'w', path: 'art/cover.png' },
    expectedSourceRevision: 'sha256:abc',
    reviewId: 'review-1',
  } as MediaContextAttachment['source'],
  selections: [
    { id: '1', selection: { kind: 'image-region', x: 1, y: 2, width: 3, height: 4 } },
    { id: '2', selection: { kind: 'image-region', x: 5, y: 6, width: 7, height: 8 } },
  ] as MediaContextAttachment['selections'],
};
type Message = React.ComponentProps<typeof MediaMessageRequestStatus>['message'];
const message = (patch: Partial<Message> = {}): Message => ({
  id: 'human-1',
  timestamp: NOW - 1000,
  contentBlocks: [
    { type: 'text', text: '请处理这两处' },
    { type: 'context_attachment', attachment: media },
  ],
  ...patch,
});
const oldMessage = () => message({ timestamp: NOW - 3 * 60 * 60 * 1000 });

type Execution = NonNullable<ContentModificationDetailView['execution']>['state'];
interface World {
  /** Requests the owner knows, as the context catalogue lists them. */
  requests: { id: string; messageId: string; cat?: string; kind?: string; createdAt?: number }[];
  names: Record<string, string>;
  execution: Record<string, Execution>;
  cancelled: Set<string>;
  contextStatus: number;
  detailStatus: number;
}
let world: World;

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const progress = (item: World['requests'][number]) => ({
  sourceMessageId: item.messageId,
  sourceKind: item.kind ?? 'human_message',
});
const requestView = (item: World['requests'][number]) => ({
  record: {
    requestId: item.id,
    ownerUserId: 'operator',
    revision: 1,
    createdAt: item.createdAt ?? 1,
    updatedAt: 1,
    progress: progress(item),
    payload: { targetCatId: item.cat ?? 'cat-a', threadId: 'execution-thread' },
  },
  stage: 'queued',
});
const detailOf = (item: World['requests'][number]) => {
  const view = requestView(item);
  return {
    ...view,
    candidates: [],
    acceptances: [],
    execution: world.execution[item.id]
      ? {
          state: world.execution[item.id],
          messageId: 'carrier',
          targetCatId: item.cat ?? 'cat-a',
          observedAt: 1,
          evidenceRef: 'e',
        }
      : undefined,
    record: {
      ...view.record,
      revision: world.cancelled.has(item.id) ? 2 : 1,
      control: world.cancelled.has(item.id)
        ? { state: 'cancelled', actorId: 'operator', cancelledAt: 1, receiptRef: 'r', taskResolution: 'preserved' }
        : undefined,
    },
  };
};

const contextCalls = () => mocks.fetch.mock.calls.filter(([url]) => String(url) === CONTEXT);

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

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
  world = {
    requests: [],
    names: { 'req-a': '烁烁' },
    execution: {},
    cancelled: new Set(),
    contextStatus: 200,
    detailStatus: 200,
  };
  mocks.fetch.mockReset();
  mocks.push.mockReset();
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path === CONTEXT) {
      if (world.contextStatus !== 200) return reply({ error: 'x' }, world.contextStatus);
      return reply({
        requests: world.requests.map(requestView),
        contexts: world.requests
          .filter((item) => world.names[item.id])
          .map((item) => ({ requestIds: [item.id], targetName: world.names[item.id] })),
      });
    }
    const id = decodeURIComponent(path.split('/')[3] ?? '');
    const item = world.requests.find((candidate) => candidate.id === id);
    if (!item) return reply({ error: 'not_found' }, 404);
    if (path.endsWith('/cancel') && init?.method === 'POST') {
      world.cancelled.add(id);
      return reply(detailOf(item));
    }
    if (world.detailStatus !== 200) return reply({ error: 'x' }, world.detailStatus);
    return reply(detailOf(item));
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

describe('MediaMessageRequestStatus', () => {
  it('shows the live line of the request a cat took over from this very message', async () => {
    world.requests = [{ id: 'req-a', messageId: 'human-1' }];
    world.execution['req-a'] = 'running';
    await render(<MediaMessageRequestStatus message={message()} resolveCatName={() => undefined} />);
    expect(lines()).toHaveLength(1);
    expect(lines()[0].getAttribute('data-state')).toBe('working');
    expect(lines()[0].textContent).toContain('修改中 · 窄屏设计稿.png 2\u00A0处');
    const [, init] = contextCalls()[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ source: media.source });
    expect(String(mocks.fetch.mock.calls.at(-1)?.[0])).toBe('/api/content-modifications/req-a');
  });

  it('cancels that request from the conversation, then says the run continues', async () => {
    world.requests = [{ id: 'req-a', messageId: 'human-1' }];
    world.execution['req-a'] = 'running';
    await render(<MediaMessageRequestStatus message={message()} resolveCatName={() => undefined} />);
    const cancel = host.querySelector('button[aria-label="取消修改"]') as HTMLButtonElement;
    await act(async () => cancel.click());
    const cancelPost = mocks.fetch.mock.calls.find(
      ([url]) => String(url) === '/api/content-modifications/req-a/cancel',
    );
    expect((cancelPost?.[1] as RequestInit | undefined)?.method).toBe('POST');
    expect(lines()[0].getAttribute('data-state')).toBe('cancelled_still_running');
    expect(host.textContent).toContain('取消修改不会停止本轮执行。');
  });

  it('names the cat that is still to start; if the data ever held several requests for one message, each gets a line', async () => {
    // Defensive only: the contract gives one Human message at most one request, reused when another cat takes it over.
    world.requests = [
      { id: 'req-a', messageId: 'human-1', createdAt: 1 },
      { id: 'req-b', messageId: 'human-1', cat: 'cat-b', createdAt: 2 },
    ];
    world.execution['req-a'] = 'queued';
    world.execution['req-b'] = 'queued';
    await render(
      <MediaMessageRequestStatus message={message()} resolveCatName={(id) => (id === 'cat-b' ? '花花' : undefined)} />,
    );
    expect(lines().map((line) => line.textContent)).toEqual([
      expect.stringContaining('烁烁尚未开始处理。'),
      expect.stringContaining('花花尚未开始处理。'),
    ]);
  });

  it('ignores requests of other messages and requests generated for this message', async () => {
    world.requests = [
      { id: 'req-other', messageId: 'human-2' },
      { id: 'req-generated', messageId: 'human-1', kind: 'generated_request' },
    ];
    await render(<MediaMessageRequestStatus message={message()} resolveCatName={() => undefined} />);
    expect(lines()).toHaveLength(0);
  });

  it('reads nothing for a message without a media attachment', async () => {
    await render(
      <MediaMessageRequestStatus
        message={message({ contentBlocks: [{ type: 'text', text: '只有字' }] })}
        resolveCatName={() => undefined}
      />,
    );
    expect(host.innerHTML).toBe('');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('leaves a message that already carries a request headline to its own presentation', async () => {
    world.requests = [{ id: 'req-a', messageId: 'human-1' }];
    await render(
      <MediaMessageRequestStatus
        message={message({ extra: { contentModificationRequestV1: { v: 1 } } as Message['extra'] })}
        resolveCatName={() => undefined}
      />,
    );
    expect(host.innerHTML).toBe('');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('says nothing before a cat has taken the message over, and an old message is read once, not polled', async () => {
    await render(<MediaMessageRequestStatus message={oldMessage()} resolveCatName={() => undefined} />);
    expect(lines()).toHaveLength(0);
    await advance(60_000);
    expect(contextCalls()).toHaveLength(1);
  });

  it('keeps looking for a fresh message until the request from this message is found, then stops looking', async () => {
    await render(<MediaMessageRequestStatus message={message()} resolveCatName={() => undefined} />);
    expect(contextCalls()).toHaveLength(1);
    await advance(4000);
    expect(contextCalls()).toHaveLength(2);
    expect(lines()).toHaveLength(0);
    world.requests = [{ id: 'req-a', messageId: 'human-1' }];
    world.execution['req-a'] = 'running';
    await advance(4000);
    expect(lines()).toHaveLength(1);
    expect(contextCalls()).toHaveLength(3);
    // The owner holds one request per Human message, so once it is found there is nothing more to discover.
    await advance(60_000);
    expect(contextCalls()).toHaveLength(3);
  });

  it('does not look again at all when the first read already holds the request, even a finished one', async () => {
    world.requests = [{ id: 'req-a', messageId: 'human-1' }];
    world.execution['req-a'] = 'finished';
    await render(<MediaMessageRequestStatus message={message()} resolveCatName={() => undefined} />);
    expect(contextCalls()).toHaveLength(1);
    await advance(40_000);
    expect(contextCalls()).toHaveLength(1);
  });

  it('is not stopped by a request of another message from the same source', async () => {
    world.requests = [{ id: 'req-other', messageId: 'human-2' }];
    await render(<MediaMessageRequestStatus message={message()} resolveCatName={() => undefined} />);
    await advance(8000);
    expect(contextCalls()).toHaveLength(3);
    world.requests.push({ id: 'req-a', messageId: 'human-1' });
    world.execution['req-a'] = 'running';
    await advance(4000);
    expect(lines()).toHaveLength(1);
    const seen = contextCalls().length;
    await advance(30_000);
    expect(contextCalls()).toHaveLength(seen);
  });

  it('is not stopped by a request that was generated for this message', async () => {
    world.requests = [{ id: 'req-generated', messageId: 'human-1', kind: 'generated_request' }];
    await render(<MediaMessageRequestStatus message={message()} resolveCatName={() => undefined} />);
    await advance(8000);
    expect(contextCalls()).toHaveLength(3);
  });

  it('after the request is found, the owner event, a focus and a reload still read again', async () => {
    world.requests = [{ id: 'req-a', messageId: 'human-1' }];
    world.execution['req-a'] = 'running';
    await render(<MediaMessageRequestStatus message={message()} resolveCatName={() => undefined} />);
    expect(contextCalls()).toHaveLength(1);
    await act(async () => {
      window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated'));
    });
    expect(contextCalls()).toHaveLength(2);
    // A focus right after a read is only a hint and is throttled; a later one reads again.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(contextCalls()).toHaveLength(2);
    await advance(20_000);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(contextCalls()).toHaveLength(3);
  });

  it('gives up looking after the window, so a message nobody takes over does not poll forever', async () => {
    await render(<MediaMessageRequestStatus message={message()} resolveCatName={() => undefined} />);
    await advance(10 * 60 * 1000);
    const seen = contextCalls().length;
    await advance(60_000);
    expect(contextCalls()).toHaveLength(seen);
    expect(seen).toBeLessThanOrEqual(1 + (10 * 60 * 1000) / 4000);
  });

  it('does not look while the page is hidden', async () => {
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      await render(<MediaMessageRequestStatus message={message()} resolveCatName={() => undefined} />);
      const first = contextCalls().length;
      await advance(20_000);
      expect(contextCalls()).toHaveLength(first);
    } finally {
      hidden.mockRestore();
    }
  });

  it('finds a late request on an old message when the work surface says something changed', async () => {
    await render(<MediaMessageRequestStatus message={oldMessage()} resolveCatName={() => undefined} />);
    world.requests = [{ id: 'req-a', messageId: 'human-1' }];
    world.execution['req-a'] = 'running';
    await act(async () => {
      window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated'));
    });
    expect(lines()).toHaveLength(1);
  });

  it('says nothing, and stops asking, when the viewer is not allowed to read it', async () => {
    world.contextStatus = 403;
    await render(<MediaMessageRequestStatus message={message()} resolveCatName={() => undefined} />);
    expect(host.innerHTML).toBe('');
    await advance(30_000);
    expect(contextCalls()).toHaveLength(1);
  });

  it('says it cannot tell, rather than nothing, when the read fails; reloading recovers', async () => {
    world.contextStatus = 500;
    await render(<MediaMessageRequestStatus message={oldMessage()} resolveCatName={() => undefined} />);
    expect(lines()[0].getAttribute('data-state')).toBe('unavailable');
    world.contextStatus = 200;
    world.requests = [{ id: 'req-a', messageId: 'human-1' }];
    world.execution['req-a'] = 'running';
    await act(async () => (host.querySelector('button[aria-label="重新加载"]') as HTMLButtonElement).click());
    expect(lines()[0].getAttribute('data-state')).toBe('working');
  });

  it('does not let an older answer that arrives late overwrite a newer one', async () => {
    let release: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = mocks.fetch.getMockImplementation();
    let contextReads = 0;
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url) === CONTEXT && ++contextReads === 1) {
        await slow;
        return reply({ requests: [], contexts: [] });
      }
      return original?.(url, init);
    });
    await render(<MediaMessageRequestStatus message={oldMessage()} resolveCatName={() => undefined} />);
    world.requests = [{ id: 'req-a', messageId: 'human-1' }];
    world.execution['req-a'] = 'running';
    await act(async () => {
      window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated'));
    });
    expect(lines()).toHaveLength(1);
    await act(async () => release?.());
    expect(lines()).toHaveLength(1);
  });

  it('reads again for the real message id once the optimistic one is replaced', async () => {
    await render(<MediaMessageRequestStatus message={oldMessage()} resolveCatName={() => undefined} />);
    world.requests = [{ id: 'req-a', messageId: 'human-server' }];
    world.execution['req-a'] = 'running';
    await render(
      <MediaMessageRequestStatus message={{ ...oldMessage(), id: 'human-server' }} resolveCatName={() => undefined} />,
    );
    expect(lines()).toHaveLength(1);
  });
});
