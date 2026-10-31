import type { ContentModificationDetailView, MediaContextAttachment, QuoteContextAttachment } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ImageWorkProgress } from '../ImageWorkProgress';
import { TextWorkProgress } from '../TextWorkProgress';
import { PROJECTION_EVENT } from '../useMediaMessageRequests';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mocks.fetch(...args) }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => ({ displayName: '烁烁' }) }) }));
vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({ pushThreadRouteWithHistory: vi.fn() }));

const REVISION = `sha256:${'a'.repeat(64)}` as const;
const locator = { worktreeId: 'w1', path: 'art/cover.png' };
const image: MediaContextAttachment = {
  v: 1,
  id: 'media-a',
  kind: 'media',
  title: 'cover.png',
  mediaType: 'image/png',
  selections: [],
  source: {
    kind: 'workspace',
    locator,
    expectedSourceRevision: REVISION,
    reviewId: 'review-1',
    expectedReviewRevision: 1,
  },
};
const quote: QuoteContextAttachment = {
  v: 1,
  id: 'quote-a',
  kind: 'quote',
  text: '原文',
  selectionStart: 0,
  selectionEnd: 2,
  source: { kind: 'workspace_file', ...locator, revision: REVISION },
};
const message = (id: string, attachment: MediaContextAttachment | QuoteContextAttachment): ChatMessage => ({
  id,
  type: 'user',
  content: '请修改',
  timestamp: 1,
  contentBlocks: [{ type: 'context_attachment', attachment }],
});
type Execution = NonNullable<ContentModificationDetailView['execution']>['state'];
let requests: Map<string, { id: string; execution: Execution; cancelled?: boolean }>;
const detail = (messageId: string) => {
  const item = requests.get(messageId);
  if (!item) return null;
  return {
    record: {
      requestId: item.id,
      ownerUserId: 'operator',
      revision: item.cancelled ? 2 : 1,
      createdAt: 1,
      updatedAt: 1,
      progress: { sourceKind: 'human_message', sourceMessageId: messageId },
      payload: { targetCatId: 'cat-a', threadId: 'thread-1' },
      ...(item.cancelled
        ? {
            control: {
              state: 'cancelled',
              actorId: 'operator',
              cancelledAt: 1,
              receiptRef: 'r',
              taskResolution: 'preserved',
            },
          }
        : {}),
    },
    stage: 'queued',
    candidates: [],
    acceptances: [],
    execution: { state: item.execution, messageId: 'carrier', targetCatId: 'cat-a', observedAt: 1, evidenceRef: 'e' },
  };
};
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let root: Root;
let host: HTMLElement;
const render = async (element: React.ReactElement) => {
  await act(async () => root.render(element));
};
const lines = () => [...host.querySelectorAll('[data-testid="modification-progress"]')];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useChatStore.setState({ messages: [], currentThreadId: 'thread-1' });
  requests = new Map([['human-a', { id: 'req-a', execution: 'running' }]]);
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/content-modifications/context')
      return reply({
        requests: [...requests.keys()].map(detail),
        contexts: [{ requestIds: ['req-a'], targetName: '烁烁' }],
      });
    const byMessage = /\/by-message\/([^/]+)$/.exec(url);
    const messageId = byMessage
      ? decodeURIComponent(byMessage[1])
      : [...requests].find(([, item]) => url.split('/')[3] === item.id)?.[0];
    const request = messageId ? requests.get(messageId) : undefined;
    if (!messageId || !request) return reply({ error: 'not_found' }, 404);
    if (init?.method === 'POST' && url.endsWith('/cancel')) request.cancelled = true;
    return reply(detail(messageId));
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('work progress is joined from real requests, not the last Human message', () => {
  it.each([
    'image',
    'text',
  ] as const)('keeps active A and its exact cancellation after later untaken %s B', async (kind) => {
    const attachment = kind === 'image' ? image : quote;
    useChatStore.setState({ messages: [message('human-a', attachment), message('human-b', attachment)] });
    await render(
      kind === 'image' ? (
        <ImageWorkProgress target={image} />
      ) : (
        <TextWorkProgress locator={locator} revision={REVISION} />
      ),
    );
    expect(lines()).toHaveLength(1);
    expect(lines()[0].getAttribute('data-state')).toBe('working');
    expect(lines()[0].textContent).toContain('cover.png');
    expect(lines()[0].textContent).toContain('烁烁修改中');
    const cancel = host.querySelector('button[aria-label="取消修改"]') as HTMLButtonElement;
    await act(async () => cancel.click());
    expect(
      mocks.fetch.mock.calls
        .filter(([url, init]) => String(url).endsWith('/cancel') && init?.method === 'POST')
        .map(([url]) => url),
    ).toEqual(['/api/content-modifications/req-a/cancel']);
    expect(lines()[0].getAttribute('data-state')).toBe('cancelled_still_running');
  });

  it.each([
    'image',
    'text',
  ] as const)('shows both real active %s requests, but not a settled historical request', async (kind) => {
    requests.set('human-b', { id: 'req-b', execution: 'queued' });
    requests.set('human-old', { id: 'req-old', execution: 'finished' });
    const attachment = kind === 'image' ? image : quote;
    useChatStore.setState({ messages: ['human-old', 'human-a', 'human-b'].map((id) => message(id, attachment)) });
    await render(
      kind === 'image' ? (
        <ImageWorkProgress target={image} />
      ) : (
        <TextWorkProgress locator={locator} revision={REVISION} />
      ),
    );
    expect(lines().map((line) => line.getAttribute('data-state'))).toEqual(['working', 'queued']);
    requests.set('human-b', { id: 'req-b', execution: 'finished' });
    await act(async () => {
      window.dispatchEvent(new Event(PROJECTION_EVENT));
    });
    expect(lines().map((line) => line.getAttribute('data-state'))).toEqual(['working']);
  });

  it('keeps an image request after only its workspace review advances, never after the bytes or file change', async () => {
    useChatStore.setState({ messages: [message('human-a', image)] });
    const source = image.source;
    if (source.kind !== 'workspace') throw new Error('workspace fixture');
    await render(<ImageWorkProgress target={{ ...image, source: { ...source, expectedReviewRevision: 2 } }} />);
    expect(lines()).toHaveLength(1);
    await render(
      <ImageWorkProgress
        target={{
          ...image,
          source: { ...source, expectedReviewRevision: 2, expectedSourceRevision: `sha256:${'b'.repeat(64)}` },
        }}
      />,
    );
    expect(lines()).toHaveLength(0);
    await render(
      <ImageWorkProgress
        target={{
          ...image,
          source: { ...source, expectedReviewRevision: 2, locator: { ...locator, path: 'other.png' } },
        }}
      />,
    );
    expect(lines()).toHaveLength(0);
  });

  it('allows only coupled review advancement within the same immutable Task and round', async () => {
    const task = {
      kind: 'media',
      taskId: 'task-a',
      expectedTaskRevision: 3,
      reviewId: 'review-1',
      round: 1,
      expectedReviewRevision: 2,
    } satisfies NonNullable<MediaContextAttachment['taskContext']>;
    const sent: MediaContextAttachment = {
      ...image,
      source: { kind: 'artifact-review', reviewId: 'review-1', round: 1, expectedReviewRevision: 2 },
      taskContext: task,
    };
    useChatStore.setState({ messages: [message('human-a', sent)] });
    const advancedTask = { ...task, expectedReviewRevision: 3 };
    const target: MediaContextAttachment = {
      ...sent,
      source: { kind: 'artifact-review', reviewId: 'review-1', round: 1, expectedReviewRevision: 3 },
      taskContext: advancedTask,
    };
    await render(<ImageWorkProgress target={target} />);
    expect(lines()).toHaveLength(1);
    for (const taskContext of [
      { ...advancedTask, taskId: 'task-b' },
      { ...advancedTask, expectedTaskRevision: 4 },
      { ...advancedTask, round: 2 },
      { ...advancedTask, expectedReviewRevision: 2 },
    ]) {
      await render(<ImageWorkProgress target={{ ...target, taskContext }} />);
      expect(lines()).toHaveLength(0);
    }
    await render(
      <ImageWorkProgress
        target={{
          ...target,
          source: { kind: 'artifact-review', reviewId: 'review-1', round: 2, expectedReviewRevision: 3 },
        }}
      />,
    );
    expect(lines()).toHaveLength(0);
  });

  it('keeps published Task A across both review revisions, refusing another immutable work or Task round', async () => {
    const source = {
      kind: 'publication',
      contentRef: `prepared-media:${'c'.repeat(64)}`,
      ownerRevision: 4,
      ledgerRef: 'published-review',
      expectedLedgerRevision: 3,
    } as const;
    const task = {
      kind: 'media',
      taskId: 'task-a',
      expectedTaskRevision: 7,
      reviewId: 'review-9',
      round: 2,
      expectedReviewRevision: 5,
    } as const;
    const sent: MediaContextAttachment = { ...image, source, taskContext: task };
    useChatStore.setState({ messages: [message('human-a', sent), message('human-b', sent)] });
    const advanced = {
      ...sent,
      source: { ...source, expectedLedgerRevision: 4 },
      taskContext: { ...task, expectedReviewRevision: 6 },
    };
    await render(<ImageWorkProgress target={advanced} />);
    expect(lines().map((line) => line.getAttribute('data-state'))).toEqual(['working']);
    for (const target of [
      { ...advanced, taskContext: { ...advanced.taskContext, taskId: 'other-task' } },
      { ...advanced, taskContext: { ...advanced.taskContext, expectedTaskRevision: 8 } },
      { ...advanced, taskContext: { ...advanced.taskContext, reviewId: 'other-review' } },
      { ...advanced, taskContext: { ...advanced.taskContext, round: 3 } },
      { ...advanced, taskContext: { ...advanced.taskContext, expectedReviewRevision: 4 } },
      { ...advanced, source: { ...advanced.source, contentRef: 'other-content' } },
      { ...advanced, source: { ...advanced.source, ownerRevision: 5 } },
      { ...advanced, source: { ...advanced.source, ledgerRef: 'other-ledger' } },
      { ...advanced, source: { ...advanced.source, expectedLedgerRevision: 2 } },
    ]) {
      await render(<ImageWorkProgress target={target} />);
      expect(lines()).toHaveLength(0);
    }
  });
});
