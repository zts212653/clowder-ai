import { createCatId, type TaskItem } from '@cat-cafe/shared';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FileData, useWorkspace } from '@/hooks/useWorkspace';
import { useChatStore } from '@/stores/chatStore';
import { useTaskStore } from '@/stores/taskStore';
import { apiFetch } from '@/utils/api-client';
import { recallSourceRecords, useRecallBindings } from '../useRecallBindings';
import { useWorkbenchBindings } from '../useWorkbenchBindings';
import { fixtureData } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { consoleValue, useOwnerProjection } from './owner-console';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
vi.mock('@/hooks/useWorkspaceFileChange', () => ({ useWorkspaceFileChange: vi.fn() }));
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let writes: { path: string; body: Record<string, unknown> }[],
  failPatch: boolean,
  noRuntime: boolean,
  gitFailure: boolean;
let task: TaskItem;
let file: FileData;
let fileAccess: { local: boolean; canOpen: boolean; canReveal: boolean };
let recallNext: string | null, recallMoreFailed: boolean;
const workspace = {
  worktreeId: 'wt',
  worktrees: [{ id: 'wt', root: '/project', branch: 'topic', head: 'abc' }],
  tree: [{ name: 'src', path: 'src', type: 'directory' }],
  loading: false,
  error: null,
  fetchTree: vi.fn(),
  fetchSubtree: vi.fn(),
} as unknown as ReturnType<typeof useWorkspace>;
beforeEach(() => {
  window.clowderChat = { dataOk: vi.fn(), dataError: vi.fn() } as unknown as typeof window.clowderChat;
  recallNext = null;
  recallMoreFailed = false;
  writes = [];
  failPatch = false;
  noRuntime = false;
  gitFailure = false;
  fileAccess = { local: true, canOpen: true, canReveal: false };
  file = {
    path: 'note.md',
    absolutePath: '/project/note.md',
    content: '# Owner text',
    sha256: 'a'.repeat(64),
    mime: 'text/markdown',
    truncated: false,
    binary: false,
    size: 12,
  };
  task = {
    id: 'task',
    kind: 'work',
    threadId: 'pdl-test',
    subjectKey: null,
    title: 'Real task',
    status: 'todo',
    ownerCatId: createCatId('codex'),
    createdBy: 'user',
    createdAt: 1,
    updatedAt: 1,
    why: 'Original instruction',
    ownerRevision: 8,
  };
  useTaskStore.getState().setTasks([task], 'pdl-test');
  useChatStore.setState({ workspaceWorktreeId: 'wt', workspaceEditToken: null, workspaceEditTokenExpiry: null });
  vi.mocked(apiFetch).mockImplementation(async (raw, init) => {
    const path = String(raw),
      url = new URL(path, 'https://api.test'),
      method = init?.method ?? 'GET';
    if (method !== 'GET') writes.push({ path, body: JSON.parse(String(init?.body ?? '{}')) });
    if (url.pathname === '/api/memory/recall') {
      if (url.searchParams.has('cursor') && recallMoreFailed) return response({ error: 'owner_page_failed' }, 503);
      return response({
        days: 0,
        from: 0,
        to: 1000,
        readStatus: 'ready',
        records: [],
        replies: [],
        nextCursor: url.searchParams.has('cursor') ? null : recallNext,
      });
    }
    if (url.pathname === '/api/tasks' && method === 'GET') return response({ tasks: [task] });
    if (url.pathname.endsWith('/sessions')) return response({ sessions: [] });
    if (url.pathname.endsWith('/invocations')) return response({ invocations: [] });
    if (url.pathname === '/api/external-runtime-sessions') return response({ sessions: [] });
    if (url.pathname.endsWith('/reviews/native')) return response({ reviews: [], nativeTargets: [{ catId: 'codex' }] });
    if (url.pathname.endsWith('/git-status'))
      return response({ staged: [], unstaged: [{ status: 'M', path: 'note.md' }], untracked: [] });
    if (url.pathname.endsWith('/git-log')) return response({ commits: [] });
    if (url.pathname.endsWith('/git-health')) {
      if (gitFailure) return response({ error: { code: 'workspace_not_git' } }, 500);
      return response({
        staleBranches: [],
        worktrees: [],
        runtimeDrift: noRuntime
          ? null
          : {
              available: true,
              aheadOfMain: 2,
              behindMain: 3,
              behindCommits: [{ short: '1234', subject: 'New change' }],
            },
      });
    }
    if (url.pathname === '/api/workspace/diff')
      return response({
        changedFiles: [{ path: 'note.md', status: 'M' }],
        diff: 'diff --git a/note.md b/note.md\n--- a/note.md\n+++ b/note.md\n@@ -1 +1 @@\n-old\n+new\n',
      });
    if (url.pathname === '/api/workspace/file') return response(file);
    if (url.pathname.endsWith('/file-info'))
      return response({ ...fileAccess, path: '/project/note.md', filename: 'note.md' });
    if (url.pathname === '/api/workspace/file/actions/open') return response({ ok: true });
    if (url.pathname === '/api/tasks/task' && method === 'PATCH') {
      if (failPatch) return response({ error: 'stale_revision' }, 409);
      task = { ...task, status: 'doing', ownerRevision: 9 };
      return response(task);
    }
    throw new Error('Unexpected workbench owner ' + path);
  });
});
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function ready() {
  const hook = renderHook(() =>
    useOwnerProjection(
      'workbench',
      useWorkbenchBindings(fixtureData(), workspace, {
        git: true,
        native: true,
        execution: true,
        recall: true,
        tasks: true,
        file: true,
      }),
    ),
  );
  await waitFor(() => expect(hook.result.current.project().git.load).toBe(''));
  return hook;
}
it('pulls an opened file only when projected and holds its full base while a reappearance pull is pending', async () => {
  let needed: boolean | number = false,
    commit!: () => void;
  const data = fixtureData();
  const hook = renderHook(() => {
    const [, refresh] = useState(0);
    commit = () => refresh((n) => n + 1);
    return useWorkbenchBindings(data, workspace, {
      git: false,
      native: false,
      execution: false,
      recall: false,
      file: needed,
    });
  });
  await act(() => hook.result.current.action('fileOpen', { p: 'note.md', w: 'wt' }));
  expect(apiFetch).not.toHaveBeenCalled();
  needed = 1;
  await act(commit);
  await waitFor(() => expect(hook.result.current.data.opened?.file.content).toBe('# Owner text'));
  const held = hook.result.current.data.opened;
  needed = false;
  await act(commit);
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  let release!: (value: Response) => void;
  vi.mocked(apiFetch).mockImplementation((path, init, options) =>
    String(path).startsWith('/api/workspace/file?')
      ? new Promise((resolve) => {
          release = resolve;
        })
      : original(path, init, options),
  );
  needed = 2;
  await act(commit);
  expect(hook.result.current.data.opened).toBe(held);
  await act(async () => release(response({ ...file, content: 'updated after reappear' })));
  expect(hook.result.current.data.opened?.file.content).toBe('updated after reappear');
});
it('projects Git patches and drift from real response fields instead of prototype status fixtures', async () => {
  const hook = await ready(),
    git = hook.result.current.project().git;
  expect(git.branch).toBe('topic');
  expect(git.drift).toMatchObject({ available: true, ahead: 2, behind: 3 });
  expect(git.groups[1].items[0].diff.hunks).toEqual([
    [
      '@@ -1 +1 @@',
      [
        ['-', 'old'],
        ['+', 'new'],
      ],
    ],
  ]);
  expect(git.behind).toEqual([{ id: '1234', title: 'New change' }]);
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).includes('/api/threads/status'))).toBe(false);
});
it('pushes project setup facts after acknowledged init, bootstrap, snooze and clone, preserving a rejected write', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  let git = false,
    status = 'missing',
    snoozed: string | null = null,
    reject = false;
  const commands: { path: string; body: unknown }[] = [];
  vi.mocked(apiFetch).mockImplementation(async (raw, init, options) => {
    const url = new URL(String(raw), 'https://api.test');
    if (url.pathname === '/api/governance/status')
      return response({ isEmptyDir: true, isGitRepo: git, gitAvailable: true });
    if (url.pathname === '/api/projects/index-state')
      return response({ status, snoozed_until: snoozed, error_message: null });
    if (['/api/projects/setup', '/api/projects/bootstrap', '/api/projects/bootstrap/snooze'].includes(url.pathname)) {
      commands.push({ path: url.pathname, body: JSON.parse(String(init!.body)) });
      if (reject) return response({ error: 'setup_refused' }, 409);
      if (url.pathname.endsWith('/setup')) git = true;
      else if (url.pathname.endsWith('/snooze')) snoozed = '2099-01-01T00:00:00Z';
      else status = 'building';
      return response({ ok: true });
    }
    return original(raw, init, options);
  });
  const { result } = await ready();
  await act(() => result.current.action('cafeProjectPrepare', { path: '/project', op: 'refresh' }));
  expect(commands).toEqual([]);
  expect(result.current.data.projectPicker.setup['/project']).toMatchObject({
    load: '',
    directory: { isGitRepo: false },
    index: { status: 'missing' },
  });
  await act(() => result.current.action('cafeProjectPrepare', { path: '/project', op: 'init' }));
  expect(result.current.data.projectPicker.setup['/project'].directory!.isGitRepo).toBe(true);
  await act(() => result.current.action('cafeProjectPrepare', { path: '/project', op: 'start' }));
  expect(result.current.data.projectPicker.setup['/project'].index!.status).toBe('building');
  await act(() => result.current.action('cafeProjectPrepare', { path: '/project', op: 'later' }));
  expect(result.current.data.projectPicker.setup['/project'].index!.snoozed_until).toBe(snoozed);
  await act(() =>
    result.current.action('cafeProjectClone', { path: '/project', gitCloneUrl: 'git@git.test:owner/repo.git' }),
  );
  expect(commands.at(-1)).toEqual({
    path: '/api/projects/setup',
    body: { projectPath: '/project', mode: 'clone', gitCloneUrl: 'git@git.test:owner/repo.git' },
  });
  const held = result.current.data.projectPicker.setup['/project'];
  reject = true;
  await act(async () => {
    await expect(result.current.action('cafeProjectPrepare', { path: '/project', op: 'init' })).rejects.toThrow(
      'setup_refused',
    );
  });
  expect(result.current.data.projectPicker.setup['/project']).toBe(held);
  expect(commands.slice(0, 3)).toEqual([
    { path: '/api/projects/setup', body: { projectPath: '/project', mode: 'init' } },
    { path: '/api/projects/bootstrap', body: { projectPath: '/project' } },
    { path: '/api/projects/bootstrap/snooze', body: { projectPath: '/project' } },
  ]);
});
it('holds raw directory and completion reads and ignores an older completion after browsing to its selection', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  let finish!: (value: Response) => void;
  vi.mocked(apiFetch).mockImplementation(async (raw, init, options) => {
    const url = new URL(String(raw), 'https://api.test');
    if (url.pathname === '/api/projects/complete')
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    if (url.pathname === '/api/projects/browse')
      return response({
        current: url.searchParams.get('path')!,
        parent: '/project',
        entries: [{ name: 'src', path: '/project/src', isDirectory: true }],
      });
    if (url.pathname === '/api/projects/drives') return response({ drives: [{ label: 'Data', path: '/data' }] });
    if (url.pathname === '/api/projects/mkdir') return response({ createdPath: '/project/new' });
    return original(raw, init, options);
  });
  const { result } = await ready();
  const pending = result.current.action('cafePathComplete', { prefix: '/pro', cwd: '/project' });
  await act(() => result.current.action('projectBrowse', { path: '/project' }));
  await act(async () => {
    finish(response({ entries: [{ name: 'old', path: '/old', isDirectory: true }] }));
    await pending;
  });
  expect(result.current.data.projectPicker.completions.entries).toEqual([]);
  expect(result.current.data.projectPicker.browse!.current).toBe('/project');
  expect(result.current.data.projectPicker.directories['/project'].entries[0].path).toBe('/project/src');
  await act(async () => {
    expect(await result.current.action('projectMkdir', { path: '/project', name: 'new' })).toEqual({
      createdPath: '/project/new',
    });
  });
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/projects/mkdir',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ parentPath: '/project', name: 'new' }) }),
    undefined,
  );
});
it('keeps the newer project index snapshot when an earlier refresh finishes late', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  const replies: ((value: Response) => void)[] = [];
  vi.mocked(apiFetch).mockImplementation(async (raw, init, options) => {
    const url = new URL(String(raw), 'https://api.test');
    if (url.pathname === '/api/governance/status')
      return response({ isEmptyDir: false, isGitRepo: true, gitAvailable: true });
    if (url.pathname === '/api/projects/index-state')
      return new Promise<Response>((resolve) => {
        replies.push(resolve);
      });
    return original(raw, init, options);
  });
  const { result } = await ready();
  const first = result.current.action('cafeProjectPrepare', { path: '/project', op: 'refresh' });
  const second = result.current.action('cafeProjectPrepare', { path: '/project', op: 'refresh' });
  await act(async () => {
    replies[1](response({ status: 'ready', snoozed_until: null, error_message: null }));
    await second;
  });
  const held = result.current.data.projectPicker.setup['/project'];
  await act(async () => {
    replies[0](response({ status: 'missing', snoozed_until: null, error_message: null }));
    await first;
  });
  expect(result.current.data.projectPicker.setup['/project']).toBe(held);
  expect(held.index!.status).toBe('ready');
});
it('keeps the Git VM usable when the owner has no runtime path and returns runtimeDrift null', async () => {
  noRuntime = true;
  const hook = await ready();
  expect(hook.result.current.project().git).toMatchObject({ load: '', drift: null, behind: [] });
});
it('keeps an HTTP error envelope out of the Git VM and marks the owner unavailable', async () => {
  gitFailure = true;
  const hook = renderHook(() =>
    useOwnerProjection(
      'workbench',
      useWorkbenchBindings(fixtureData(), workspace, {
        git: true,
        native: true,
        execution: true,
        recall: true,
        tasks: true,
        file: true,
      }),
    ),
  );
  await waitFor(() => expect(hook.result.current.project().git.load).toBe('error'));
  expect(hook.result.current.project().git.behind).toEqual([]);
});
it('keeps task status unchanged on stale revisions, then applies the actual guarded receipt', async () => {
  const hook = await ready();
  failPatch = true;
  await act(async () => {
    await expect(hook.result.current.action('taskStatus', { id: 'task' })).rejects.toThrow('stale_revision');
  });
  expect(useTaskStore.getState().tasks[0].status).toBe('todo');
  expect(writes[0].body).toEqual({ status: 'doing', expectedOwnerRevision: 8 });
  failPatch = false;
  await act(() => hook.result.current.action('taskStatus', { id: 'task' }));
  expect(useTaskStore.getState().tasks[0].ownerRevision).toBe(9);
});
it('opens and downloads the same admitted file and only exposes actions granted by file-info', async () => {
  const hook = await ready();
  await act(() => hook.result.current.action('fileOpen', { p: 'note.md', w: 'wt' }));
  await waitFor(() => expect(hook.result.current.project().filePage?.actions.load).toBe(''));
  const page = hook.result.current.project().filePage;
  expect(page).toMatchObject({
    mode: 'render',
    markdown: true,
    binary: false,
    hasBody: true,
    media: null,
    fileInfo: null,
  });
  expect(page?.binary && !page.media).toBe(false);
  expect(page?.actions.source).toBe('https://api.test/api/workspace/file/download?worktreeId=wt&path=note.md');
  expect(page?.actions.canOpen).toBe(true);
  expect(page?.actions.canReveal).toBe(false);
  await act(() => hook.result.current.action('fileAction', { op: 'open', worktreeId: 'wt', path: 'note.md' }));
  expect(writes.at(-1)).toEqual({ path: '/api/workspace/file/actions/open?worktreeId=wt&path=note.md', body: {} });
  hook.result.current.state.fileMode = 'src';
  expect(hook.result.current.project().filePage).toMatchObject({ mode: 'src', markdown: true, hasBody: true });
});
it('keeps reveal in menuActions and hides denied file operations using the same file-info receipt', async () => {
  fileAccess = { local: true, canOpen: false, canReveal: true };
  const hook = await ready();
  await act(() => hook.result.current.action('fileOpen', { p: 'note.md', w: 'wt' }));
  await waitFor(() => expect(hook.result.current.project().filePage?.actions.load).toBe(''));
  const actions = hook.result.current.project().filePage!.actions;
  expect(actions.canOpen).toBe(false);
  expect(actions.canReveal).toBe(true);
});
it.each([
  ['image', 'image/png', 'assets/owner #.png'],
  ['video', 'video/mp4', 'assets/owner.mp4'],
  ['audio', 'audio/wav', 'assets/owner.wav'],
])('uses the authorized raw owner URL for a binary %s without exposing text modes', async (kind, mime, path) => {
  file = { ...file, path, absolutePath: `/project/${path}`, content: '', mime, binary: true };
  const hook = await ready();
  await act(() => hook.result.current.action('fileOpen', { p: path, w: 'wt' }));
  await waitFor(() => expect(hook.result.current.project().filePage?.actions.load).toBe(''));
  const page = hook.result.current.project().filePage;
  expect(page).toMatchObject({ binary: true, hasBody: false, markdown: false, fileInfo: null });
  expect(page?.binary && !page.media).toBe(false);
  expect(page?.media).toEqual({
    id: `file:/project/${path}`,
    kind,
    src: `https://api.test/api/workspace/file/raw?${new URLSearchParams({ worktreeId: 'wt', path })}`,
    label: path.split('/').pop(),
    marks: [],
  });
  expect(new URL(page!.actions.source).searchParams.get('path')).toBe(path);
});
it.each([
  'pages',
  'slides',
  'sheets',
  undefined,
] as const)('projects actual Office %s units with pageCount and source facts', async (pageUnit) => {
  const modifiedAt = '2026-11-03T10:00:00.000Z';
  file = {
    ...file,
    path: 'owner.pptx',
    absolutePath: '/project/owner.pptx',
    content: '',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    binary: true,
    size: 2048,
    modifiedAt,
    pageCount: 3,
    pageUnit,
  };
  const hook = await ready();
  await act(() => hook.result.current.action('fileOpen', { p: file.path, w: 'wt' }));
  expect(hook.result.current.project().filePage).toMatchObject({
    binary: true,
    hasBody: false,
    markdown: false,
    media: null,
    fileInfo: { mime: file.mime, size: 2048, modifiedAt, pageCount: 3, pageUnit },
  });
  const page = hook.result.current.project().filePage;
  expect(page?.binary && !page.media).toBe(true);
});
it('omits missing binary metadata and keeps ordinary source files as text', async () => {
  file = { ...file, path: 'owner.bin', content: '', mime: 'application/octet-stream', binary: true, size: undefined };
  const hook = await ready();
  await act(() => hook.result.current.action('fileOpen', { p: file.path, w: 'wt' }));
  expect(hook.result.current.project().filePage).toMatchObject({
    binary: true,
    fileInfo: {
      mime: 'application/octet-stream',
      size: undefined,
      modifiedAt: undefined,
      pageCount: undefined,
      pageUnit: undefined,
    },
    media: null,
    hasBody: false,
  });
  const binaryPage = hook.result.current.project().filePage;
  expect(binaryPage?.binary && !binaryPage.media).toBe(true);
  file = { ...file, path: 'owner.ts', mime: 'text/plain', binary: false, content: 'const owner = true;' };
  await act(() => hook.result.current.action('fileOpen', { p: file.path, w: 'wt' }));
  expect(hook.result.current.project().filePage).toMatchObject({
    binary: false,
    hasBody: true,
    mode: 'src',
    markdown: false,
    body: file.content,
    media: null,
    fileInfo: null,
  });
});
it('starts a native review with the chosen session owner and actual target/delivery instead of a demo event', async () => {
  const hook = await ready();
  await waitFor(() => expect(hook.result.current.project().git.nativeTargets).toHaveLength(1));
  hook.result.current.state.review.target = 'base';
  hook.result.current.state.review.base = 'origin/review-base';
  hook.result.current.state.review.mode = 'thread';
  await act(() => hook.result.current.action('wcReviewStart', {}));
  expect(writes.at(-1)).toEqual({
    path: '/api/threads/pdl-test/reviews/native',
    body: { target: { kind: 'base_branch', branch: 'origin/review-base' }, delivery: 'detached', catId: 'codex' },
  });
  expect(hook.result.current.project().git.reviews).toEqual([]);
});
it('opens verified recall sources and resolves the reply by the exact cat turn instead of its parent', () => {
  const messages = [
    { ...fixtureData().messages[1], extra: { stream: { invocationId: 'parent', turnInvocationId: 'child' } } },
  ];
  const [profile, thread] = consoleValue('recallItems(events, threadId)', {
    events: recallSourceRecords(
      [
        {
          id: 'recall',
          catId: 'codex',
          invocationId: 'child',
          query: '真实来源',
          timestamp: 1,
          results: [
            {
              title: 'Owner profile',
              href: '/memory?family=profile&memoryId=primer%3Arelationship&revision=rev-owner&from=pdl-test',
            },
            { title: 'Owner message', href: '/thread/foreign-thread?message=foreign-mid' },
          ],
        },
      ],
      messages,
    ),
    threadId: 'pdl-test',
  });
  expect(profile).toMatchObject({
    act: 'memOpen',
    args: { family: 'profile', id: 'primer:relationship', revision: 'rev-owner' },
    ctx: { reply: { mid: 'reply-1', thread: 'pdl-test' } },
  });
  expect(thread).toMatchObject({ act: 'msgJump', args: { thread: 'foreign-thread', mid: 'foreign-mid' } });
});
it('groups recall by the real cat and child invocation, newest reply first, without using event time as reply identity', () => {
  const data = fixtureData();
  const messages = [
    {
      ...data.messages[1],
      id: 'old',
      timestamp: 10,
      extra: { stream: { turnInvocationId: 'child-old', invocationId: 'parent' } },
    },
    {
      ...data.messages[1],
      id: 'new',
      timestamp: 20,
      extra: { stream: { turnInvocationId: 'child-new', invocationId: 'parent' } },
    },
  ];
  const event = { id: 'old-event', query: 'old query', catId: 'codex', invocationId: 'child-old', timestamp: 100 };
  const groups = consoleValue('recallGroups(events, data)', {
    events: recallSourceRecords(
      [
        event,
        { ...event, id: 'new-event', invocationId: 'child-new', timestamp: 50 },
        { ...event, id: 'second-old' },
        { ...event, id: 'other-cat', catId: 'other' },
      ],
      messages,
    ),
    data: data,
  });
  expect(groups.map((group: { key: string; count: number }) => [group.key, group.count])).toEqual([
    ['unlocated', 0],
    ['new', 1],
    ['old', 2],
  ]);
  expect(groups[0].who.name).toContain('other');
  expect(groups[1].who.name).toContain('Codex');
  expect(groups[2].items.map((item: { ctx: { reply: { mid: string } | null } }) => item.ctx.reply?.mid)).toEqual([
    'old',
    'old',
  ]);
  expect(groups[0].items[0].ctx.reply).toBeNull();
  expect(groups[0].items[0].canLocate).toBe(false);
});
it('continues the event cursor and retries that exact page after a failed read', async () => {
  recallNext = 'owner-event-cursor';
  const hook = await ready();
  await waitFor(() => expect(hook.result.current.project().cafeWsRecall.events.next).toBe(recallNext));
  recallMoreFailed = true;
  await act(() => hook.result.current.action('recallEventsMore', { cursor: recallNext! }));
  expect(hook.result.current.project().cafeWsRecall).toMatchObject({ load: 'error', events: { next: recallNext } });
  recallMoreFailed = false;
  await act(() => hook.result.current.action('refresh', { k: 'recall' }));
  expect(hook.result.current.project().cafeWsRecall).toMatchObject({ load: '', events: { next: null } });
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([path]) => String(path).includes('cursor=owner-event-cursor')),
  ).toHaveLength(2);
});
it('does not create recall source links from missing, revoked, corrected or unsupported destinations', () => {
  const results = [
    { title: 'Owner only', href: null },
    {
      title: 'Corrected',
      href: '/thread/private',
      sourceUnavailableReason: 'source_corrected' as const,
      snippet: 'Old private text',
    },
    { title: 'Unavailable', titleStatus: 'unavailable' as const, href: '/thread/private' },
    { title: 'Unread document route', href: '/memory/search?q=doc-owner' },
    { title: 'External', href: '//other.test/thread/private' },
  ];
  const rows = consoleValue('recallItems(events, threadId)', {
    events: recallSourceRecords([{ id: 'recall', query: 'Owner search', timestamp: 1, results }], []),
    threadId: 'pdl-test',
  });
  expect(
    rows.every(
      (row: { act: string; args: unknown; ctx: { source: unknown } }) =>
        row.act === '' && row.args === null && row.ctx.source === null,
    ),
  ).toBe(true);
  expect(rows[1].sub).not.toContain('Old private text');
});

it('uses the existing edit lease and keeps the draft through conflict reload and explicit overwrite', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  let conflict = true;
  vi.mocked(apiFetch).mockImplementation(async (raw, init) => {
    if (raw === '/api/workspace/edit-session') {
      writes.push({ path: String(raw), body: JSON.parse(String(init?.body)) });
      return response({ token: 'actual-edit-lease', expiresIn: 120 });
    }
    if (raw === '/api/workspace/file' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      writes.push({ path: String(raw), body });
      if (conflict) return response({ error: 'file_conflict' }, 409);
      file = { ...file, content: body.content, sha256: 'c'.repeat(64) };
      return response({ path: file.path, sha256: file.sha256 });
    }
    return original(raw, init);
  });
  const hook = await ready();
  await act(() => hook.result.current.action('fileOpen', { p: 'note.md', w: 'wt' }));
  await act(() => hook.result.current.action('fileEdit', { worktreeId: 'wt', path: 'note.md' }));
  expect(writes[0]).toEqual({ path: '/api/workspace/edit-session', body: { worktreeId: 'wt' } });
  expect(hook.result.current.project().filePage).toMatchObject({
    editing: true,
    mode: 'src',
    hasBody: true,
    name: 'note.md',
  });
  await act(() => hook.result.current.action('fileDraft', { id: '/project/note.md', content: 'My draft' }));
  await act(() => hook.result.current.action('fileSave', { id: '/project/note.md', baseSha256: 'a'.repeat(64) }));
  expect(writes.at(-1)?.body).toEqual({
    worktreeId: 'wt',
    path: 'note.md',
    content: 'My draft',
    baseSha256: 'a'.repeat(64),
    editSessionToken: 'actual-edit-lease',
  });
  expect(hook.result.current.project().filePage?.edit).toMatchObject({
    content: 'My draft',
    conflict: expect.stringContaining('冲突'),
  });
  expect(hook.result.current.project().fileDraftDirty).toBe(true);
  file = { ...file, content: 'Server changed', sha256: 'b'.repeat(64) };
  await act(() => hook.result.current.action('fileConflict', { id: '/project/note.md', op: 'reload' }));
  expect(hook.result.current.project().filePage?.edit).toMatchObject({
    content: 'Server changed',
    baseSha256: 'b'.repeat(64),
    conflict: '',
  });
  expect(hook.result.current.project().fileDraftDirty).toBe(false);
  await act(() => hook.result.current.action('fileDraft', { id: '/project/note.md', content: 'Explicit overwrite' }));
  conflict = false;
  await act(() => hook.result.current.action('fileConflict', { id: '/project/note.md', op: 'overwrite' }));
  expect(writes.at(-1)?.body).toMatchObject({ content: 'Explicit overwrite', baseSha256: 'b'.repeat(64) });
  expect(hook.result.current.project().filePage).toMatchObject({
    editing: false,
    body: 'Explicit overwrite',
    edit: null,
  });
  expect(hook.result.current.project().fileDraftDirty).toBe(false);
  await act(() => hook.result.current.action('fileEdit', { worktreeId: 'wt', path: 'note.md' }));
  await act(() => hook.result.current.action('fileDraft', { id: '/project/note.md', content: 'Cancelled draft' }));
  await act(() => hook.result.current.action('fileCancel', { id: '/project/note.md' }));
  expect(hook.result.current.project().filePage).toMatchObject({ editing: false, body: 'Explicit overwrite' });
  expect(hook.result.current.project().fileDraftDirty).toBe(false);
});

it('loads the selected reply through event cursors without discarding other reply groups or inventing coordinates', async () => {
  vi.mocked(apiFetch).mockClear();
  const data = fixtureData();
  const reply = {
    ...data.messages[1],
    id: 'focus-reply',
    catId: 'codex',
    timestamp: 10,
    extra: { stream: { turnInvocationId: 'child-focus' } },
  };
  data.messages = [reply];
  const state = { recallFor: 'focus-reply', recallExpected: 2 };
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    const url = new URL(String(path), 'https://api.test');
    expect(url.searchParams.get('threadId')).toBe(data.threadId);
    expect(url.searchParams.get('days')).toBe('0');
    const older = url.searchParams.has('cursor');
    return response({
      days: 0,
      from: 0,
      to: 100,
      readStatus: 'ready',
      records: (older
        ? [
            { id: 'focus-2', invocationId: 'child-focus', query: 'Earlier focus event', catId: 'codex', timestamp: 3 },
            { id: 'orphan', query: 'Without reply', catId: 'codex', timestamp: 2 },
          ]
        : [
            { id: 'focus-1', invocationId: 'child-focus', query: 'Latest focus event', catId: 'codex', timestamp: 8 },
            { id: 'other', messageId: 'other-reply', query: 'Other reply event', catId: 'codex', timestamp: 7 },
          ]
      ).map((event) => ({ threadId: data.threadId, threadTitle: 'Thread', event })),
      replies: [{ threadId: data.threadId, messageId: 'other-reply', catId: 'codex', timestamp: 6 }],
      nextCursor: older ? null : 'actual-event-cursor',
    });
  });
  const hook = renderHook(() =>
    useOwnerProjection('recall', useRecallBindings(data, state, true), { data, ws: state }),
  );
  await waitFor(() => expect(hook.result.current.project().cafeWsRecall.events.next).toBeNull());
  await waitFor(() =>
    expect(
      hook.result.current.project().cafeWsRecall.groups.find((g: { key: string }) => g.key === 'focus-reply')?.count,
    ).toBe(2),
  );
  const model = hook.result.current.project().cafeWsRecall;
  expect(model).toMatchObject({ filtered: true, filterFor: 'focus-reply' });
  expect(model.groups.find((g: { key: string }) => g.key === 'other-reply')?.count).toBe(1);
  expect(model.groups.find((g: { key: string }) => g.key === 'unlocated')?.items[0]).toMatchObject({
    canLocate: false,
    mid: undefined,
  });
  state.recallFor = '';
  await act(() => hook.result.current.action('recallBrowse', {}));
  expect(hook.result.current.project().cafeWsRecall.filtered).toBe(false);
  expect(apiFetch).toHaveBeenCalledTimes(2);
});
