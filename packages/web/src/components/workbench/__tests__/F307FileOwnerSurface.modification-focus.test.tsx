import type { ContentModificationRecord } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearModificationFocus,
  focusModification,
  usePendingModificationFocus,
} from '@/components/content-review/modification-focus';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { useChatStore } from '@/stores/chatStore';
import { F307FileOwnerSurface } from '../F307FileOwnerSurface';
import { createFileSurface } from '../real-surface-adapters';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3102',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('@/hooks/useFileEditing', () => ({
  useFileEditing: () => ({
    editMode: false,
    setEditMode: vi.fn(),
    saveError: null,
    canEdit: false,
    handleToggleEdit: vi.fn(),
    handleSave: vi.fn(),
  }),
}));
vi.mock('@/components/workspace/WorkspaceFileViewer', () => ({
  WorkspaceFileViewer: () => <div data-testid="ordinary-file" />,
}));
// This test isolates the real file owner's disclosure. The real inner owner/candidate is exercised by the browser journey.
vi.mock('../content-review/WorkspaceContentReviewSurface', () => ({
  WorkspaceContentReviewSurface: ({ onBack, onOpenFileTools }: { onBack: () => void; onOpenFileTools: () => void }) => {
    const pending = usePendingModificationFocus();
    return (
      <div data-testid="review-owner" data-pending-candidate={pending?.candidateRef}>
        <button type="button" onClick={onBack}>
          返回来源
        </button>
        <button type="button" onClick={onOpenFileTools}>
          文件工具
        </button>
      </div>
    );
  },
}));

const threadId = 'thread-source';
const origin = { kind: 'chat-file-link' as const, threadId, messageId: 'human-source' };
const record: ContentModificationRecord = {
  requestId: 'request',
  ownerUserId: 'operator',
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  progress: {},
  payload: {
    operationId: 'operation',
    targetCatId: 'codex61-sol',
    threadId,
    intent: { body: '修改原文' },
    source: {
      kind: 'workspace',
      locator: { worktreeId: 'worktree-a', path: 'notes.txt' },
      expectedSourceRevision: `sha256:${'a'.repeat(64)}`,
      reviewId: 'review',
      expectedReviewRevision: 1,
    },
  },
};
const file = () =>
  new Response(
    JSON.stringify({
      path: 'notes.txt',
      content: '# Original',
      sha256: 'source-sha',
      size: 10,
      mime: 'text/plain',
      truncated: false,
    }),
  );

describe('v2 non-Markdown file owner consumes the disclosure part of a receipt comparison navigation', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onReturn = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    localStorage.clear();
    writeShellPresentation('v2');
    clearModificationFocus();
    onReturn.mockReset();
    useChatStore.setState({ currentThreadId: threadId, workspaceOpenRevision: 7, presentationLock: null });
    mocks.apiFetch.mockReset().mockImplementation(async () => file());
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => {
      root.unmount();
      clearModificationFocus();
    });
    container.remove();
    writeShellPresentation('classic');
    localStorage.clear();
    vi.unstubAllGlobals();
  });
  const mount = () =>
    act(async () => {
      root.render(
        <F307FileOwnerSurface
          surface={createFileSurface({ worktreeId: 'worktree-a', path: 'notes.txt', navigationOrigin: origin })}
          onRequestDetach={vi.fn()}
          onReturnToNavigationOrigin={onReturn}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  const focus = (patch: Partial<Parameters<typeof focusModification>[0]> = {}) =>
    act(async () =>
      focusModification({ record, candidateRef: 'candidate-1', navigation: { threadId, revision: 7 }, ...patch }),
    );
  const review = () => container.querySelector<HTMLElement>('[data-testid="review-owner"]');

  it('cold-mounts comparison directly from the receipt and retains exact source return', async () => {
    await focus();
    await mount();
    expect(review()?.dataset.pendingCandidate).toBe('candidate-1');
    expect(container.querySelector('[data-testid="ordinary-file"]')).toBeNull();
    const back = [...container.querySelectorAll('button')].find((button) => button.textContent === '返回来源');
    expect(back).toBeDefined();
    await act(async () => back?.click());
    expect(onReturn).toHaveBeenCalledWith(origin);
  });
  it('opens comparison on an already mounted ordinary file tab', async () => {
    await mount();
    await act(async () =>
      [...container.querySelectorAll('button')].find((button) => button.textContent === '文件工具')!.click(),
    );
    expect(container.querySelector('[data-testid="ordinary-file"]')).not.toBeNull();
    await focus();
    expect(review()?.dataset.pendingCandidate).toBe('candidate-1');
  });
  it('reopens comparison after a full owner remount without saved tab disclosure', async () => {
    await mount();
    await act(async () => root.unmount());
    root = createRoot(container);
    await focus();
    await mount();
    expect(review()?.dataset.pendingCandidate).toBe('candidate-1');
  });
  it('keeps the accepted comparison navigation while the file read arrives late', async () => {
    let resolve!: (response: Response) => void;
    mocks.apiFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((finish) => {
          resolve = finish;
        }),
    );
    await mount();
    await focus();
    expect(review()).toBeNull();
    await act(async () => resolve(file()));
    expect(review()?.dataset.pendingCandidate).toBe('candidate-1');
  });
  it.each([
    { navigation: { threadId: 'foreign-thread', revision: 7 } },
    { navigation: { threadId, revision: 6 } },
    {
      record: {
        ...record,
        payload: {
          ...record.payload,
          source: { ...record.payload.source, locator: { worktreeId: 'foreign-worktree', path: 'notes.txt' } },
        },
      } as ContentModificationRecord,
    },
    {
      record: {
        ...record,
        payload: {
          ...record.payload,
          source: { ...record.payload.source, locator: { worktreeId: 'worktree-a', path: 'foreign.md' } },
        },
      } as ContentModificationRecord,
    },
  ])('does not open comparison for another source or navigation: %j', async (patch) => {
    await mount();
    await act(async () =>
      [...container.querySelectorAll('button')].find((button) => button.textContent === '文件工具')!.click(),
    );
    await focus(patch);
    expect(review()).toBeNull();
    expect(container.querySelector('[data-testid="ordinary-file"]')).not.toBeNull();
  });
});
