import type { ContentModificationDetailView, ContentModificationReceiptV1 } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { view as reviewView } from '@/components/workbench/content-review/__tests__/WorkspaceContentReviewSurface.fixture';
import { WorkspaceModificationEntry } from '@/components/workbench/content-review/WorkspaceModificationEntry';
import { useChatStore } from '@/stores/chatStore';
import { ContentModificationReceiptCard } from '../ContentModificationReceiptCard';
import { clearModificationFocus } from '../modification-focus';

/**
 * F309 R32: a Host receipt in the conversation must take the person back to the exact candidate diff it names, not
 * only to the original file. The receipt card and the real workspace entry (with its real landing, panel and
 * results) share one tree; only the network and the chat store's navigation are stubbed.
 */
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.fetch(...args),
}));

const REQUEST_ID = `f309-modification-${'a'.repeat(64)}`;
const OTHER_REQUEST_ID = `f309-modification-${'d'.repeat(64)}`;
const review = reviewView();
const reviewSource = review.review.source;
if (reviewSource.kind !== 'text') throw new Error('fixture must be a text file');
const source = {
  kind: 'workspace' as const,
  locator: reviewSource.locator,
  expectedSourceRevision: reviewSource.revision,
  reviewId: review.review.reviewId,
  expectedReviewRevision: review.review.revision,
};
const baseRevision = `sha256:${'a'.repeat(64)}`;

function candidate(ref: string, replacement: string) {
  return {
    kind: 'text' as const,
    candidateRef: ref,
    proposal: {
      proposalRef: ref,
      requestId: REQUEST_ID,
      revision: 1,
      operationId: `operation-${ref}`,
      baseRevision,
      resultRevision: `sha256:${'b'.repeat(64)}`,
      edits: [{ start: 0, end: 3, expectedText: 'old', replacement }],
      response: `回复 ${ref}`,
      authorCatId: 'codex-terra',
      createdAt: 10,
      receiptRef: `proposal-receipt-${ref}`,
    },
  };
}

function detail(requestId: string, refs: string[], patchSource = source): ContentModificationDetailView {
  return {
    stage: 'queued',
    candidates: refs.map((ref) => candidate(ref, `改后-${ref}`)),
    acceptances: [],
    record: {
      requestId,
      ownerUserId: 'operator',
      revision: 3,
      createdAt: 1,
      updatedAt: 3,
      progress: { task: { taskId: 'task-1', revision: 1, receiptRef: 'task-receipt' } },
      payload: {
        operationId: `op-${requestId}`,
        source: patchSource,
        targetCatId: 'codex-terra',
        threadId: 'execution',
        intent: { body: '把第二段改短' },
      },
    },
  } as unknown as ContentModificationDetailView;
}

function receipt(
  state: ContentModificationReceiptV1['state'],
  patch: Partial<ContentModificationReceiptV1> = {},
): ContentModificationReceiptV1 {
  return {
    v: 1,
    requestId: REQUEST_ID,
    sourceMessageId: 'human-source',
    targetCatId: 'codex-terra',
    taskId: 'task-1',
    state,
    ...(state === 'unknown' ? {} : { candidateRef: 'proposal-two' }),
    receiptRef: 'receipt-1',
    observedAt: 1,
    followUp: { kind: 'none', reason: 'not_applicable' },
    ...patch,
  } as ContentModificationReceiptV1;
}

const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const choices = {
  cats: [{ catId: 'codex-terra', name: '小团团', mcpSupport: true, restrictions: [] }],
  threads: [{ threadId: 'execution', title: '修改说明' }],
};

let root: Root;
let host: HTMLElement;
// The chat store's real navigation actions are used: a receipt's ask is tied to the revision they mint, so a stubbed
// openWorkspacePath (or a hand-edited revision) would hide exactly the production paths that must retire it.
const realOpenWorkspacePath = useChatStore.getState().openWorkspacePath;
type OpenArgs = Parameters<typeof realOpenWorkspacePath>;
const openWorkspacePath = vi.fn((...args: OpenArgs) => realOpenWorkspacePath(...args));
const onExpanded = vi.fn();
// jsdom has no layout; the spy is the proof that the named candidate is the one brought into view.
const scrollIntoView = vi.fn();
let requests: Record<string, ContentModificationDetailView>;

async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function mountPair(entryView = review, card: ContentModificationReceiptV1 = receipt('candidate')) {
  return act(async () => {
    root.render(
      <>
        <ContentModificationReceiptCard
          receipt={card}
          messageId="host-receipt-1"
          getCatById={(id) => (id === 'codex-terra' ? { displayName: '小团团' } : undefined)}
        />
        <WorkspaceModificationEntry
          view={entryView}
          path="notes.md"
          target={null}
          disabled={false}
          onExpanded={onExpanded}
        />
      </>,
    );
    await flush();
  });
}

const clickReceipt = () =>
  act(async () => {
    host.querySelector<HTMLButtonElement>('[data-message-id="host-receipt-1"] button')?.click();
    await flush();
  });
const results = () => [...host.querySelectorAll<HTMLElement>('[data-testid="content-modification-result"]')];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  clearModificationFocus();
  mocks.fetch.mockReset();
  openWorkspacePath.mockReset();
  openWorkspacePath.mockImplementation((...args: OpenArgs) => realOpenWorkspacePath(...args));
  onExpanded.mockReset();
  scrollIntoView.mockReset();
  (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = scrollIntoView;
  requests = { [REQUEST_ID]: detail(REQUEST_ID, ['proposal-one', 'proposal-two']) };
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url === '/api/content-modifications/choices') return json(choices);
    if (url === '/api/content-modifications/context')
      return json({
        requests: Object.values(requests),
        // The request's own task, as the owner lists it, so the landing has nothing more to look up.
        contexts: [
          {
            taskId: 'task-1',
            title: '把第二段改短',
            targetCatId: 'codex-terra',
            threadId: 'execution',
            targetName: '小团团',
            threadTitle: '修改说明',
            completionRule: 'file-writeback-applied',
            requestIds: Object.keys(requests),
            state: 'active',
            taskContext: { kind: 'text', taskId: 'task-1', expectedTaskRevision: 1 },
          },
        ],
        suggestedCatId: 'codex-terra',
      });
    const id = decodeURIComponent(url.replace('/api/content-modifications/', ''));
    return requests[id] ? json(requests[id]) : new Response('{}', { status: 404 });
  });
  useChatStore.setState({
    currentThreadId: 'thread-1',
    currentProjectPath: '/tmp/project',
    threadStates: {},
    workspaceWorktreeId: 'worktree-a',
    workspaceOpenTabs: [],
    workspaceOpenFilePath: null,
    workspaceOpenRevision: 0,
    workspaceOpenRequest: null,
    presentationLock: null,
    openWorkspacePath,
  } as never);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  clearModificationFocus();
  vi.useRealTimers();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe('a Host receipt takes the person to the exact candidate it names', () => {
  it('opens the workspace panel on that request and shows the named candidate diff, not just the file', async () => {
    await mountPair();
    expect(results()).toHaveLength(0);
    await clickReceipt();
    expect(openWorkspacePath).toHaveBeenCalledTimes(1);
    expect(onExpanded).toHaveBeenCalled();
    const shown = results();
    expect(shown.map((node) => node.getAttribute('data-candidate-ref'))).toEqual(['proposal-one', 'proposal-two']);
    const focused = shown.filter((node) => node.getAttribute('data-focused') === 'true');
    expect(focused).toHaveLength(1);
    expect(focused[0]?.getAttribute('data-candidate-ref')).toBe('proposal-two');
    expect(focused[0]?.textContent).toContain('改后-proposal-two');
    expect(focused[0]?.textContent).toContain('回复 proposal-two');
    // It is also brought into view, and only that one is. Its top goes to the top of the panel: a candidate taller than
    // the panel (a comparison of two pictures) is otherwise left with only its header at the edge of the window.
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(scrollIntoView.mock.contexts[0]).toBe(focused[0]);
  });

  describe('the ask belongs to the navigation that made it', () => {
    const renderCardOnly = (card: ContentModificationReceiptV1 = receipt('conflict')) =>
      act(async () => {
        root.render(
          <ContentModificationReceiptCard receipt={card} messageId="host-receipt-1" getCatById={() => undefined} />,
        );
      });
    const focusedResults = () => results().filter((node) => node.getAttribute('data-focused') === 'true');

    it('works the same when the entry mounts only after the file has been opened', async () => {
      await renderCardOnly();
      await clickReceipt();
      expect(onExpanded).not.toHaveBeenCalled();
      // The Workspace shows the file after the navigation; the entry is not on screen until then.
      await mountPair(review, receipt('conflict'));
      expect(focusedResults()).toHaveLength(1);
      expect(onExpanded).toHaveBeenCalledTimes(1);
    });

    it('does not lose an accepted click when the Workspace mounts slowly', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      await renderCardOnly();
      await clickReceipt();
      vi.setSystemTime(Date.now() + 10 * 60 * 1000);
      await mountPair(review, receipt('conflict'));
      expect(focusedResults()).toHaveLength(1);
    });

    it('is retired by an ordinary file navigation (chat file link, file tree, search) and never revives', async () => {
      await renderCardOnly();
      await clickReceipt();
      // The person opens something else the ordinary way before the Workspace shows this file's panel.
      await act(async () =>
        useChatStore.getState().setWorkspaceOpenFile('elsewhere.md', null, 'worktree-a', 'thread-1'),
      );
      await mountPair(review, receipt('conflict'));
      expect(onExpanded).not.toHaveBeenCalled();
      expect(results()).toHaveLength(0);
      // Coming back to this very file the ordinary way does not bring the old click back to life.
      await act(async () => useChatStore.getState().setWorkspaceOpenFile('notes.md', null, 'worktree-a', 'thread-1'));
      await mountPair(review, receipt('conflict'));
      expect(onExpanded).not.toHaveBeenCalled();
      expect(results()).toHaveLength(0);
    });

    it('is retired by a later explicit open request too', async () => {
      await renderCardOnly();
      await clickReceipt();
      await act(async () => {
        realOpenWorkspacePath('thread-1', { kind: 'file', worktreeId: 'worktree-a', path: 'elsewhere.md' });
      });
      await mountPair(review, receipt('conflict'));
      expect(onExpanded).not.toHaveBeenCalled();
      expect(results()).toHaveLength(0);
    });

    it('a fresh click after being superseded works again', async () => {
      await renderCardOnly();
      await clickReceipt();
      await act(async () =>
        useChatStore.getState().setWorkspaceOpenFile('elsewhere.md', null, 'worktree-a', 'thread-1'),
      );
      await clickReceipt();
      await mountPair(review, receipt('conflict'));
      expect(focusedResults()).toHaveLength(1);
    });

    it('is not taken in another conversation, and waits for its own', async () => {
      await renderCardOnly();
      await clickReceipt();
      await act(async () => useChatStore.setState({ currentThreadId: 'thread-2' } as never));
      await mountPair(review, receipt('conflict'));
      expect(onExpanded).not.toHaveBeenCalled();
      expect(results()).toHaveLength(0);
      // Back in the conversation the click was made in, that navigation is still the newest one.
      await act(async () => {
        useChatStore.setState({ currentThreadId: 'thread-1' } as never);
        await flush();
      });
      expect(focusedResults()).toHaveLength(1);
    });
  });

  it('does not open a candidate when the receipt only asks for the file (applied)', async () => {
    await mountPair(review, receipt('applied'));
    await clickReceipt();
    expect(openWorkspacePath).toHaveBeenCalledTimes(1);
    expect(onExpanded).not.toHaveBeenCalled();
    expect(results()).toHaveLength(0);
  });

  it('ignores a receipt for another file instead of opening this file’s panel', async () => {
    // A different file is a different review object (its own reviewId), which is what the panel keys its context on.
    const otherSource = {
      ...source,
      reviewId: `workspace-review-${'e'.repeat(64)}`,
      locator: { ...source.locator, path: 'other.md' },
    };
    requests[OTHER_REQUEST_ID] = detail(OTHER_REQUEST_ID, ['proposal-two'], otherSource);
    await mountPair(review, receipt('candidate', { requestId: OTHER_REQUEST_ID }));
    await clickReceipt();
    expect(openWorkspacePath).toHaveBeenCalledTimes(1);
    expect(onExpanded).not.toHaveBeenCalled();
    expect(results()).toHaveLength(0);
  });

  it('forgets the pending focus when the Workspace did not take the file (conversation switched)', async () => {
    openWorkspacePath.mockReturnValue(false);
    await mountPair();
    await clickReceipt();
    expect(onExpanded).not.toHaveBeenCalled();
    expect(results()).toHaveLength(0);
  });
});
