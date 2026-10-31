import type { ContentModificationRecord } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearModificationFocus, focusModification } from '@/components/content-review/modification-focus';
import { useChatStore } from '@/stores/chatStore';
import { WorkspaceContentReviewSurface } from '../WorkspaceContentReviewSurface';
import { workspaceReviewRequestSource } from '../workspace-modification-source';
import { mediaView } from './WorkspaceContentReviewSurface.fixture';

const landing = vi.hoisted(() => ({ props: null as null | { onClose: () => void } }));
const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('@/components/content-review/ContentModificationLanding', () => ({
  ContentModificationLanding: (props: { onClose: () => void }) => {
    landing.props = props;
    return <output data-testid="landing">panel</output>;
  },
}));

const THREAD = 'thread-comparing-surface';
const view = mediaView();
const record = {
  requestId: `f309-modification-${'4'.repeat(64)}`,
  ownerUserId: view.review.ownerUserId,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  progress: {},
  payload: { source: workspaceReviewRequestSource(view) },
} as unknown as ContentModificationRecord;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useChatStore.setState({ currentThreadId: THREAD, workspaceOpenRevision: 9 });
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/workspace/content-reviews/prepare') return new Response(JSON.stringify(view));
    throw new Error(`unexpected route: ${url}`);
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <WorkspaceContentReviewSurface
        worktreeId="worktree-a"
        path="cover.png"
        sourceText=""
        sourceTextRevision=""
        onBack={vi.fn()}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
});
afterEach(() => {
  clearModificationFocus();
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const layout = () => container.querySelector('[data-comparing]');
const back = () => container.querySelector<HTMLButtonElement>('[data-testid="workspace-return-to-artwork"]');
const receiptAsksForCandidate = () =>
  act(async () =>
    focusModification({ record, candidateRef: 'candidate-v2', navigation: { threadId: THREAD, revision: 9 } }),
  );

it('lays the returned version out as the main thing once a receipt asks for it, and gives the artwork back on request', async () => {
  expect(layout()).toBeNull();
  expect(back()).toBeNull();
  await receiptAsksForCandidate();
  expect(layout()?.getAttribute('data-comparing')).toBe('true');
  expect(back()?.textContent).toBe('回到作品画面');
  // The artwork is still there, only not in the way: nothing it holds (marks, draft, selection) is torn down.
  expect(container.querySelector('[data-testid="workspace-review-artwork"]')).not.toBeNull();
  await act(async () => back()?.click());
  expect(layout()).toBeNull();
  expect(back()).toBeNull();
  // The panel itself stays open: going back to the picture is not closing the comparison's panel.
  expect(container.querySelector('[data-testid="landing"]')).not.toBeNull();
});

const newerNavigation = (revision: number) =>
  act(async () => useChatStore.setState({ workspaceOpenRevision: revision }));

it('is out of date once a newer navigation reaches the Workspace: opening the file again shows the artwork', async () => {
  await receiptAsksForCandidate();
  expect(layout()).not.toBeNull();
  // The same file, opened again by an ordinary link or the file tree: the surface keeps its instance and its panel.
  await newerNavigation(10);
  expect(layout()).toBeNull();
  expect(back()).toBeNull();
  expect(container.querySelector('[data-testid="landing"]')).not.toBeNull();
});

it('is ended by a receipt that only asks for the file, and a later candidate ask enters it again', async () => {
  await receiptAsksForCandidate();
  expect(layout()).not.toBeNull();
  await newerNavigation(10);
  await act(async () => focusModification({ record, navigation: { threadId: THREAD, revision: 10 } }));
  expect(layout()).toBeNull();
  await newerNavigation(11);
  await act(async () =>
    focusModification({ record, candidateRef: 'candidate-v3', navigation: { threadId: THREAD, revision: 11 } }),
  );
  expect(layout()?.getAttribute('data-comparing')).toBe('true');
  expect(back()).not.toBeNull();
});

it('is over when the panel is closed', async () => {
  await receiptAsksForCandidate();
  expect(layout()).not.toBeNull();
  await act(async () => landing.props?.onClose());
  expect(layout()).toBeNull();
  expect(back()).toBeNull();
});

it('does not change the layout when the receipt only asks for the file', async () => {
  await act(async () => focusModification({ record, navigation: { threadId: THREAD, revision: 9 } }));
  expect(container.querySelector('[data-testid="landing"]')).not.toBeNull();
  expect(layout()).toBeNull();
});
