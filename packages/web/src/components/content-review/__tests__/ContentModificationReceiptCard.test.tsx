import type { ContentModificationReceiptV1 } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { ContentModificationReceiptCard } from '../ContentModificationReceiptCard';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mocks.fetch(...args) }));
const getCatById = (id: string) => (id === 'codex-sol' ? { displayName: '烁烁' } : undefined);

const REQUEST_ID = `f309-modification-${'a'.repeat(64)}`;

function receipt(
  state: ContentModificationReceiptV1['state'],
  patch: Partial<ContentModificationReceiptV1> = {},
): ContentModificationReceiptV1 {
  return {
    v: 1,
    requestId: REQUEST_ID,
    sourceMessageId: 'human-source',
    targetCatId: 'codex-sol',
    taskId: 'task-1',
    state,
    ...(state === 'unknown' ? {} : { candidateRef: 'candidate-secret' }),
    receiptRef: 'receipt-secret',
    observedAt: 1,
    followUp: { kind: 'none', reason: 'not_applicable' },
    ...patch,
  } as ContentModificationReceiptV1;
}

const requestView = (source: unknown) =>
  new Response(
    JSON.stringify({
      stage: 'queued',
      candidates: [],
      acceptances: [],
      record: { requestId: REQUEST_ID, payload: { source } },
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
const workspaceSource = { kind: 'workspace', locator: { worktreeId: 'work-1', path: 'docs/guide.md' } };

let root: Root;
let host: HTMLElement;
const openWorkspacePath = vi.fn(() => true);
const render = async (element: React.ReactElement) => {
  await act(async () => {
    root.render(element);
  });
};
const card = (state: ContentModificationReceiptV1['state'] = 'candidate') => (
  <ContentModificationReceiptCard receipt={receipt(state)} messageId="host-receipt-1" getCatById={getCatById} />
);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.fetch.mockReset();
  openWorkspacePath.mockReset();
  openWorkspacePath.mockReturnValue(true);
  useChatStore.setState({ currentThreadId: 'thread-1', openWorkspacePath } as never);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('ContentModificationReceiptCard', () => {
  it('shows a clean line in the accepted wording and none of the internal coordinates', async () => {
    await render(card('candidate'));
    const text = host.textContent ?? '';
    expect(text).toContain('烁烁提交了修改');
    expect(text).toContain('原文件尚未因此改变。');
    expect(text).not.toMatch(
      /f309-modification|candidate-secret|receipt-secret|requestId|candidateRef|receiptRef|Host 作品修改回执/,
    );
    expect(host.querySelector('[data-message-id="host-receipt-1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="modification-progress"]')?.getAttribute('data-state')).toBe(
      'receipt_candidate',
    );
  });

  it('keeps the line compact so its action stays next to the words it belongs to', async () => {
    // Filling most of a wide chat column pushes "打开对照" far from the sentence it opens.
    await render(card('candidate'));
    const line = host.querySelector('[data-message-id="host-receipt-1"] > div');
    expect(line?.className).toContain('max-w-md');
    expect(line?.className).not.toContain('max-w-[85%]');
  });

  it('reads nothing until the reader asks to open it', async () => {
    await render(card('candidate'));
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('opens the original file from the request, and remembers the chat message to come back to', async () => {
    mocks.fetch.mockImplementation(async () => requestView(workspaceSource));
    await render(card('candidate'));
    await act(async () => (host.querySelector('button[aria-label="打开对照"]') as HTMLButtonElement).click());
    expect(String(mocks.fetch.mock.calls[0][0])).toBe(`/api/content-modifications/${REQUEST_ID}`);
    expect(openWorkspacePath).toHaveBeenCalledWith('thread-1', {
      kind: 'file',
      worktreeId: 'work-1',
      path: 'docs/guide.md',
      navigationOrigin: { kind: 'chat-file-link', threadId: 'thread-1', messageId: 'host-receipt-1' },
    });
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('offers the file itself once the write-back is applied or cannot be confirmed', async () => {
    for (const state of ['applied', 'unknown'] as const) {
      await render(card(state));
      expect(host.querySelector('button[aria-label="打开文件"]')).not.toBeNull();
      expect(host.querySelector('button[aria-label="打开对照"]')).toBeNull();
    }
    await render(card('applied'));
    expect(host.querySelector('[data-indicator="success"]')).not.toBeNull();
  });

  it('says so when the original is not a file this chat can open', async () => {
    // A published work or a Task round opens through its review (receipt-opens-artifact-round.test.tsx); an
    // experiment's original is neither, so it still says plainly that it cannot be opened from here.
    mocks.fetch.mockImplementation(async () => requestView({ kind: 'evolution', reviewId: 'r' }));
    await render(card('candidate'));
    await act(async () => (host.querySelector('button') as HTMLButtonElement).click());
    expect(openWorkspacePath).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('这份修改的原作品不是文件，暂时无法在这里打开。');
  });

  it('tells a viewer without access instead of reporting a vague failure', async () => {
    mocks.fetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: 'access_denied' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await render(card('candidate'));
    await act(async () => (host.querySelector('button') as HTMLButtonElement).click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('你已无权打开这份修改，或它已不存在。');
  });

  it('keeps a transient failure retryable', async () => {
    mocks.fetch.mockImplementationOnce(async () => {
      throw new Error('network down');
    });
    mocks.fetch.mockImplementation(async () => requestView(workspaceSource));
    await render(card('candidate'));
    const open = () => act(async () => (host.querySelector('button') as HTMLButtonElement).click());
    await open();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('暂时无法打开，请重试。');
    await open();
    expect(openWorkspacePath).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('does not steal focus when the conversation changed while the request was being read', async () => {
    openWorkspacePath.mockReturnValue(false);
    mocks.fetch.mockImplementation(async () => requestView(workspaceSource));
    await render(card('candidate'));
    await act(async () => (host.querySelector('button') as HTMLButtonElement).click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('对话已切换。回到来源后可以继续打开。');
  });

  it('asks to open in the conversation the reader clicked in, even if another is current when the read returns', async () => {
    mocks.fetch.mockImplementation(async () => {
      useChatStore.setState({ currentThreadId: 'thread-2' } as never);
      return requestView(workspaceSource);
    });
    await render(card('candidate'));
    await act(async () => (host.querySelector('button') as HTMLButtonElement).click());
    expect(openWorkspacePath).toHaveBeenCalledWith('thread-1', expect.objectContaining({ kind: 'file' }));
  });

  it('ignores a second click while the first is still being read', async () => {
    let release: (() => void) | undefined;
    mocks.fetch.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return requestView(workspaceSource);
    });
    await render(card('candidate'));
    const button = host.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      button.click();
      button.click();
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect((host.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      release?.();
    });
    expect(openWorkspacePath).toHaveBeenCalledTimes(1);
  });

  it('falls back to neutral wording for a cat it cannot name', async () => {
    await render(
      <ContentModificationReceiptCard
        receipt={receipt('candidate', { targetCatId: 'someone-else' })}
        messageId="m"
        getCatById={getCatById}
      />,
    );
    expect(host.textContent).toContain('收到一份修改');
  });
});
