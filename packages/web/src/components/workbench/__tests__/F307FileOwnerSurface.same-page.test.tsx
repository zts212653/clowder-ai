import type { ContentModificationRecord, ContentModificationRequest } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearModificationFocus, focusModification } from '@/components/content-review/modification-focus';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import type { WorkspaceFileSave } from '@/components/workspace/workspace-file-draft';
import { addWorkspaceFileQuoteToChat } from '@/components/workspace/workspace-file-quote';
import { useChatStore } from '@/stores/chatStore';
import { revision, view } from '../content-review/__tests__/WorkspaceContentReviewSurface.fixture';
import { F307FileOwnerSurface } from '../F307FileOwnerSurface';
import { createFileSurface } from '../real-surface-adapters';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), startDocument: vi.fn() }));
vi.mock('@/services/DocumentListenController', () => ({
  documentListenController: { startDocument: mocks.startDocument },
}));
vi.mock('@/services/DocumentCacheController', () => ({
  documentCacheController: {
    refresh: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
  },
}));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test', apiFetch: mocks.apiFetch }));
vi.mock('@/hooks/useWorkspaceFileChange', () => ({
  useWorkspaceFileChange: () => ({ pendingExternalSha: null, onDirtyChange: vi.fn() }),
}));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => <p data-source-line="1">{content}</p>,
}));
vi.mock('@/components/workspace/CodeViewer', () => ({
  CodeViewer: ({ editable, onSave }: { editable: boolean; onSave: WorkspaceFileSave }) => (
    <div data-testid="original-source-editor" data-editable={String(editable)}>
      {editable && (
        <button type="button" onClick={() => void onSave('saved by original editor')}>
          保存文件
        </button>
      )}
    </div>
  ),
}));
vi.mock('@/components/content-review/ContentModificationLanding', () => ({
  ContentModificationLanding: ({
    source,
    focusCandidateRef,
  }: {
    source: ContentModificationRequest['source'];
    focusCandidateRef?: string;
  }) => (
    <div
      data-testid="original-modification-landing"
      data-source={JSON.stringify(source)}
      data-candidate={focusCandidateRef}
    />
  ),
}));

let host: HTMLDivElement;
let root: Root;
const originalStore = useChatStore.getState();
const onReturn = vi.fn();
const sourceText = 'A unique source quote.';
const sha = revision.replace('sha256:', '');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  writeShellPresentation('v2');
  onReturn.mockReset();
  mocks.startDocument.mockReset();
  clearModificationFocus();
  useChatStore.setState({
    currentThreadId: 'thread-a',
    workspaceOpenRevision: 7,
    pendingChatInsert: null,
    currentProjectPath: '/repo',
  });
  mocks.apiFetch.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/workspace/file?'))
      return new Response(
        JSON.stringify({
          path: 'notes.md',
          content: sourceText,
          sha256: sha,
          size: 22,
          mime: 'text/markdown',
          truncated: false,
        }),
      );
    if (url === '/api/workspace/content-reviews/prepare') return new Response(JSON.stringify(view()));
    if (url === '/api/workspace/edit-session')
      return new Response(JSON.stringify({ token: 'scoped-edit', expiresIn: 60 }));
    if (url === '/api/workspace/file' && init?.method === 'PUT')
      return new Response(JSON.stringify({ path: 'notes.md', sha256: sha }));
    throw new Error(`unexpected request: ${url}`);
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  clearModificationFocus();
  host.remove();
  useChatStore.setState(originalStore, true);
  localStorage.clear();
  vi.restoreAllMocks();
});

async function render() {
  await act(async () =>
    root.render(
      <F307FileOwnerSurface
        surface={createFileSurface({
          worktreeId: 'worktree-a',
          path: 'notes.md',
          navigationOrigin: { kind: 'workspace-home-search', query: 'notes' },
        })}
        onRequestDetach={vi.fn()}
        onReturnToNavigationOrigin={onReturn}
      />,
    ),
  );
}

async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => button?.click());
}

it('keeps the original reader mounted while collaboration opens or fails, with no tools-page detour', async () => {
  let failPrepare: (value: Response) => void = () => undefined;
  const preparation = new Promise<Response>((resolve) => {
    failPrepare = resolve;
  });
  mocks.apiFetch
    .mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            path: 'notes.md',
            content: sourceText,
            sha256: sha,
            size: 22,
            mime: 'text/markdown',
            truncated: false,
          }),
        ),
    )
    .mockImplementationOnce(() => preparation);
  await render();
  const reader = host.querySelector('[data-testid="workspace-file-viewer"]');
  expect(reader, 'reading does not wait for review preparation').not.toBeNull();
  expect(reader?.textContent).toContain(sourceText);
  await act(async () => failPrepare(new Response('{}', { status: 503 })));
  expect(host.querySelector('[data-testid="workspace-file-viewer"]')).toBe(reader);
  expect(host.textContent).not.toContain('文件工具');
  expect(host.querySelector('[data-testid="workspace-content-review-text"]')).not.toBeNull();
});

it('keeps source, edit/save, listening and return in the same original file surface', async () => {
  await render();
  const reader = host.querySelector('[data-testid="workspace-file-viewer"]');
  expect(reader).not.toBeNull();
  await click('渲染');
  expect(host.querySelector('[data-testid="original-source-editor"]')?.getAttribute('data-editable')).toBe('false');
  await click('编辑');
  expect(host.querySelector('[data-testid="original-source-editor"]')?.getAttribute('data-editable')).toBe('true');
  await click('保存文件');
  const write = mocks.apiFetch.mock.calls.find(
    ([url, init]) => url === '/api/workspace/file' && init?.method === 'PUT',
  );
  expect(JSON.parse(String(write?.[1].body))).toEqual({
    worktreeId: 'worktree-a',
    path: 'notes.md',
    content: 'saved by original editor',
    baseSha256: sha,
    editSessionToken: 'scoped-edit',
  });
  expect(host.querySelector('[data-testid="workspace-file-viewer"]')).toBe(reader);
  await click('编辑中');
  await click('源码');
  const listen = host.querySelector<HTMLButtonElement>('button[title="从上次位置开始听读"]');
  expect(listen).not.toBeNull();
  await act(async () => listen!.click());
  expect(mocks.startDocument).toHaveBeenCalledWith(
    expect.objectContaining({
      identity: { projectPath: '/repo', relativePath: 'notes.md', contentDigest: sha },
      worktreeId: 'worktree-a',
    }),
    undefined,
  );
  await click('‹ 工具搜索');
  expect(onReturn).toHaveBeenCalledWith({ kind: 'workspace-home-search', query: 'notes' });
});

it('the file toolbar uses that exact file/version in the existing Chat without opening a second request form', async () => {
  await render();
  const reader = host.querySelector('[data-testid="workspace-file-viewer"]');
  expect(reader).not.toBeNull();
  const composer = document.createElement('div');
  composer.dataset.guideId = 'chat.input';
  const input = document.createElement('textarea');
  input.value = 'original draft';
  input.setSelectionRange(3, 8, 'backward');
  composer.append(input);
  document.body.append(composer);
  useChatStore.setState({ pendingChatInsert: { threadId: 'thread-a', text: input.value } });
  expect(
    addWorkspaceFileQuoteToChat('thread-a', {
      text: sourceText,
      comment: 'keep this place',
      worktreeId: 'worktree-a',
      path: 'notes.md',
      revision,
    }),
  ).toEqual({ kind: 'added' });
  const queued = useChatStore.getState().pendingChatInsert;
  expect(queued?.contextAttachments?.[0]).toMatchObject({
    text: sourceText,
    comment: 'keep this place',
    source: { kind: 'workspace_file', worktreeId: 'worktree-a', path: 'notes.md', revision },
  });
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
  const requestsBefore = mocks.apiFetch.mock.calls.length;
  try {
    await click('请猫修改');
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('original draft');
    expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([3, 8, 'backward']);
    expect(useChatStore.getState().pendingChatInsert).toBe(queued);
    expect(mocks.apiFetch.mock.calls.slice(requestsBefore)).toEqual([]);
    expect(host.querySelector('[data-testid="original-modification-landing"]')).toBeNull();
  } finally {
    composer.remove();
  }
  expect(host.querySelector('[data-testid="workspace-file-viewer"]')).toBe(reader);
  expect(host.querySelectorAll('[data-testid="workspace-content-review-text"]')).toHaveLength(1);
});

it.each([
  'thread-a',
  'another-thread',
])('receipt focus stays bound to its original navigation (%s)', async (threadId) => {
  const record: ContentModificationRecord = {
    requestId: 'same-page-request',
    ownerUserId: 'operator',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    progress: {},
    payload: {
      operationId: 'same-page-operation',
      targetCatId: 'codex61-sol',
      threadId: 'thread-a',
      intent: { body: '改原文' },
      source: {
        kind: 'workspace',
        locator: { worktreeId: 'worktree-a', path: 'notes.md' },
        expectedSourceRevision: revision,
        reviewId: view().review.reviewId,
        expectedReviewRevision: 1,
      },
    },
  };
  focusModification({ record, candidateRef: 'exact-candidate', navigation: { threadId, revision: 7 } });
  await render();
  expect(host.querySelector('[data-testid="workspace-file-viewer"]')).not.toBeNull();
  const landing = host.querySelector<HTMLElement>('[data-testid="original-modification-landing"]');
  if (threadId === 'thread-a') expect(landing?.dataset.candidate).toBe('exact-candidate');
  else expect(landing).toBeNull();
});
