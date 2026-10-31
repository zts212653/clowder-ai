import type { ContentModificationDetailView, ContentModificationSourceMessageV1 } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentModificationSourceMessage } from '../ContentModificationSourceMessage';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), push: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mocks.fetch(...args) }));
vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({
  pushThreadRouteWithHistory: (...args: unknown[]) => mocks.push(...args),
}));

const metadata: ContentModificationSourceMessageV1 = {
  v: 1,
  requestId: `f309-modification-${'a'.repeat(64)}`,
  requestFingerprint: `sha256:${'b'.repeat(64)}`,
  contentTitle: '窄屏设计稿',
  targetCatId: 'codex-sol',
  targetName: '烁烁',
  executionThreadTitle: 'F309 workspace studio改造',
  completionRule: 'published-result-ready',
};

type Execution = NonNullable<ContentModificationDetailView['execution']>['state'];
function detail(patch: { revision?: number; execution?: Execution; cancelled?: boolean } = {}) {
  return {
    stage: 'queued',
    candidates: [],
    acceptances: [],
    execution: patch.execution
      ? { state: patch.execution, messageId: 'carrier', targetCatId: 'codex-sol', observedAt: 1, evidenceRef: 'e' }
      : undefined,
    record: {
      requestId: metadata.requestId,
      ownerUserId: 'operator',
      revision: patch.revision ?? 1,
      createdAt: 1,
      updatedAt: 1,
      progress: {},
      payload: { threadId: 'execution-thread' },
      control: patch.cancelled
        ? { state: 'cancelled', actorId: 'operator', cancelledAt: 1, receiptRef: 'r', taskResolution: 'preserved' }
        : undefined,
    },
  } as unknown as ContentModificationDetailView;
}
const ok = (view: ContentModificationDetailView) =>
  new Response(JSON.stringify(view), { status: 200, headers: { 'content-type': 'application/json' } });

let root: Root;
let host: HTMLElement;
const render = async (element: React.ReactElement) => {
  await act(async () => {
    root.render(element);
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.fetch.mockReset();
  mocks.push.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('ContentModificationSourceMessage progress line', () => {
  it('keeps the request headline and adds the live, real progress under it', async () => {
    mocks.fetch.mockImplementation(async () => ok(detail({ execution: 'running' })));
    await render(<ContentModificationSourceMessage metadata={metadata} />);
    expect(host.querySelector('[data-testid="content-modification-source"]')?.textContent).toContain(
      '请烁烁修改《窄屏设计稿》',
    );
    const row = host.querySelector('[data-testid="modification-progress"]');
    expect(row?.getAttribute('data-state')).toBe('working');
    expect(row?.textContent).toContain('修改中 · 窄屏设计稿');
    expect(String(mocks.fetch.mock.calls[0][0])).toBe(`/api/content-modifications/${metadata.requestId}`);
  });

  it('cancels the request from the conversation and then shows that the run continues', async () => {
    let cancelled = false;
    mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        cancelled = true;
        return ok(detail({ revision: 2, execution: 'running', cancelled: true }));
      }
      return ok(detail({ revision: cancelled ? 2 : 1, execution: 'running', cancelled }));
    });
    await render(<ContentModificationSourceMessage metadata={metadata} />);
    const cancel = host.querySelector('button[aria-label="取消修改"]') as HTMLButtonElement;
    await act(async () => cancel.click());
    const post = mocks.fetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(String(post?.[0])).toBe(`/api/content-modifications/${metadata.requestId}/cancel`);
    expect(host.querySelector('[data-testid="modification-progress"]')?.getAttribute('data-state')).toBe(
      'cancelled_still_running',
    );
    expect(host.textContent).toContain('取消修改不会停止本轮执行。');
  });

  it('opens the execution conversation of a failed run', async () => {
    mocks.fetch.mockImplementation(async () => ok(detail({ execution: 'failed' })));
    await render(<ContentModificationSourceMessage metadata={metadata} />);
    const open = host.querySelector('button[aria-label="打开执行对话"]') as HTMLButtonElement;
    await act(async () => open.click());
    expect(mocks.push).toHaveBeenCalledWith('execution-thread', window);
  });

  it('says nothing extra when the viewer cannot read the request', async () => {
    mocks.fetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: 'access_denied' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await render(<ContentModificationSourceMessage metadata={metadata} />);
    expect(host.querySelector('[data-testid="modification-progress"]')).toBeNull();
    expect(host.querySelector('[data-testid="content-modification-source"]')?.textContent).toContain('请烁烁修改');
  });

  it('renders nothing and reads nothing for metadata that is not a verified request', async () => {
    await render(<ContentModificationSourceMessage metadata={{ v: 1, requestId: 'nope' }} />);
    expect(host.innerHTML).toBe('');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
