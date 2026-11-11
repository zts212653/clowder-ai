'use client';
import type { TaskItem } from '@cat-cafe/shared';
import { parseUnifiedDiff } from '@cat-cafe/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type ContentFileInfo,
  contentFileInfo,
  runContentFileAction,
} from '@/components/content-review/file-action-client';
import { useFileEditing } from '@/hooks/useFileEditing';
import type { GitHealthResult } from '@/hooks/useGitHealth';
import type { CommitDetail, GitCommit, GitStatusResult } from '@/hooks/useGitPanel';
import type { FileData, useWorkspace } from '@/hooks/useWorkspace';
import { useWorkspaceFileChange } from '@/hooks/useWorkspaceFileChange';
import { useWorkspaceSearch } from '@/hooks/useWorkspaceSearch';
import type { ThreadNativeReviewRunV1, ThreadNativeReviewTarget } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useTaskStore } from '@/stores/taskStore';
import { apiFetch } from '@/utils/api-client';
import type { FetchSourceResult } from '@/utils/signals-api';
import type { ChatData } from './chat-models';
import { request, write } from './owner-api';
import { useExecutionBindings } from './useExecutionBindings';
import { useRecallBindings } from './useRecallBindings';

interface WorkspacePatch {
  changedFiles: { path: string; status: string }[];
  diff: string;
}
interface GitData {
  status: GitStatusResult;
  log: {
    commits: (GitCommit & Pick<CommitDetail, 'files'>)[];
  };
  health: GitHealthResult;
}
interface ProjectDirectory {
  current: string;
  parent: string | null;
  entries: { name: string; path: string; isDirectory: boolean }[];
}
interface ProjectSetupRead {
  load: string;
  directory?: { isEmptyDir: boolean; isGitRepo: boolean; gitAvailable: boolean };
  index?: { status: string; snoozed_until: string | null; error_message: string | null };
}
export function useWorkbenchBindings(
  data: ChatData,
  workspace: ReturnType<typeof useWorkspace>,
  needed: {
    git: boolean | number;
    native: boolean | number;
    execution: boolean | number;
    recall: boolean | number;
    tasks?: boolean | number;
    file?: boolean | number;
  } = {
    git: false,
    native: false,
    execution: false,
    recall: false,
  },
) {
  const picker = useRef({
    browse: null as ProjectDirectory | null,
    directories: {} as Record<string, ProjectDirectory>,
    drives: [] as { label: string; path: string }[],
    completions: { prefix: '', entries: [] as ProjectDirectory['entries'] },
    setup: {} as Record<string, ProjectSetupRead>,
  });
  const [, publishPicker] = useState(0);
  const completionRead = useRef(0);
  const setupReads = useRef<Record<string, number>>({});
  const readDirectory = async (path: string) => {
    const query = path ? '?' + new URLSearchParams({ path }) : '';
    const directory = await request<ProjectDirectory>('/api/projects/browse' + query);
    picker.current = {
      ...picker.current,
      directories: { ...picker.current.directories!, [directory.current]: directory },
    };
    publishPicker((n) => n + 1);
    return directory;
  };
  const readProject = async (path: string) => {
    const ticket = (setupReads.current[path] = (setupReads.current[path] || 0) + 1);
    picker.current = { ...picker.current, setup: { ...picker.current.setup!, [path]: { load: 'loading' } } };
    publishPicker((n) => n + 1);
    const query = '?' + new URLSearchParams({ projectPath: path });
    try {
      const [directory, index] = await Promise.all([
        request<NonNullable<ProjectSetupRead['directory']>>('/api/governance/status' + query),
        request<NonNullable<ProjectSetupRead['index']>>('/api/projects/index-state' + query),
      ]);
      if (setupReads.current[path] === ticket)
        picker.current = {
          ...picker.current,
          setup: { ...picker.current.setup!, [path]: { load: '', directory, index } },
        };
    } catch (error) {
      if (setupReads.current[path] !== ticket) return;
      picker.current = { ...picker.current, setup: { ...picker.current.setup!, [path]: { load: 'error' } } };
      throw error;
    } finally {
      publishPicker((n) => n + 1);
    }
  };
  const state = useRef({
    tkF: 'all',
    recallPages: 0,
    recallFor: null as string | null,
    recallExpected: 0,
    fileMode: 'render',
    gitView: 'status',
    q: '',
    qMode: 'all',
    wt: '',
    execQ: '',
    tjMode: 'timeline',
    diffMode: 'unified',
    pane: 'mine',
    execDetail: null as string | null,
    scheduleDate: Date.now(),
    scheduleMode: 'month',
    boardV: 'list',
    hbItem: null as string | null,
    hbView: 'sug',
    depScope: 'connected',
    node: null as string | null,
    zoom: 1,
    pan: [0, 0],
    evalView: 'overview',
    pawF: 'active',
    sigView: 'list',
    sigDetail: null as string | null,
    pod: 0,
    sigSt: 'inbox',
    sigTier: 'all',
    sigSrc: 'all',
    sigQ: '',
    sigSel: {} as Record<string, boolean>,
    tlDays: '7',
    fetchRes: '' as string | FetchSourceResult['summary'],
    teamV: 'roster',
    teamSub: null as string | null,
    teamByThread: {} as Record<string, { q: string; f: string }>,
    evoId: null as string | null,
    evoReading: {} as Record<string, { view: string; stage: number | null; decision: string; notice: string }>,
    opsView: 'quota',
    rtView: null as string | null,
    rtTab: 'chat' as 'chat' | 'handoff' | 'raw',
    rtPage: 1,
    govPath: null as string | null,
    gov: {} as Record<string, boolean | string>,
    rescueSel: {} as Record<string, boolean>,
    obsV: 'overview',
    lbRange: 'all',
    toolCat: '',
    toolType: '',
    toolRange: 7,
    rpReview: false,
    rpArch: false,
    reviewOpen: false,
    review: { target: 'uncommitted', mode: 'session', base: 'origin/main', sha: '', ask: '' },
    canon: null as unknown,
    film: null as unknown,
    clipPreview: null as unknown,
  });
  const execution = useExecutionBindings(data, state.current, needed.execution);
  const [opened, setOpened] = useState<{ worktreeId: string; file: FileData } | null>(null);
  const [fileTarget, setFileTarget] = useState<{ worktreeId: string; path: string } | null>(null);
  const [fileAttempt, reloadFile] = useState(0);
  const openRequest = useRef(0);
  const fileEdits = useRef<Record<string, { content: string; original: string; baseSha256: string }>>({});
  const [, publishDrafts] = useState(0);
  const fetchOpenedFile = async (path: string) => {
    const worktreeId = opened!.worktreeId;
    const file = await request<FileData>(`/api/workspace/file?${new URLSearchParams({ worktreeId, path })}`);
    setOpened({ worktreeId, file });
  };
  const editing = useFileEditing({
    worktreeId: opened?.worktreeId ?? null,
    openFilePath: opened?.file.path ?? null,
    file: opened?.file ?? null,
    fetchFile: fetchOpenedFile,
  });
  useWorkspaceFileChange({
    enabled: Boolean(needed.file),
    worktreeId: opened?.worktreeId ?? null,
    path: opened?.file.path ?? null,
    currentSha: opened?.file.sha256 ?? null,
    onReload: () => reloadFile((attempt) => attempt + 1),
  });
  useEffect(() => {
    if (!needed.file || !fileTarget) return;
    const abort = new AbortController(),
      ticket = ++openRequest.current,
      { worktreeId, path } = fileTarget;
    setOpened((current) => (current?.worktreeId === worktreeId && current.file.path === path ? current : null));
    void request<FileData>(`/api/workspace/file?${new URLSearchParams({ worktreeId, path })}`, {
      signal: abort.signal,
    }).then(
      (file) => {
        if (abort.signal.aborted || ticket !== openRequest.current) return;
        setOpened({ worktreeId, file });
        editing.setEditMode(!!fileEdits.current[JSON.stringify([worktreeId, file.path])]);
        editing.setSaveError(null);
        window.clowderChat.dataOk('workbench.file');
      },
      (error: Error) => {
        if (abort.signal.aborted || ticket !== openRequest.current) return;
        setOpened(null);
        window.clowderChat.dataError('workbench.file', error);
      },
    );
    return () => abort.abort();
  }, [needed.file, fileTarget?.worktreeId, fileTarget?.path, fileAttempt]);
  const editToken = async () => {
    const store = useChatStore.getState(),
      worktreeId = workspace.worktreeId;
    if (!worktreeId) throw new Error('请先选择工作区');
    if (store.workspaceEditToken && store.workspaceEditTokenExpiry! > Date.now())
      return { worktreeId, token: store.workspaceEditToken };
    const lease = await write<{ token: string; expiresIn: number }>('/api/workspace/edit-session', { worktreeId });
    if (useChatStore.getState().workspaceWorktreeId === worktreeId)
      store.setWorkspaceEditToken(lease.token, lease.expiresIn);
    return { worktreeId, token: lease.token };
  };
  const changeFile = async (path: string, body: Record<string, unknown>, method = 'POST') => {
    const owner = await editToken();
    await write(path, { ...body, worktreeId: owner.worktreeId, editSessionToken: owner.token }, method);
    await workspace.fetchTree();
  };
  const [fileInfo, setFileInfo] = useState<{ scope: string; load: string; info?: ContentFileInfo }>({
    scope: '',
    load: 'loading',
  });
  const [patch, setPatch] = useState<{
    id: string;
    data: WorkspacePatch;
    parsed: ReturnType<typeof parseUnifiedDiff>;
  }>();
  const fileSearch = useWorkspaceSearch(workspace.worktreeId);
  const [taskError, setTaskError] = useState<Error | null>(null);
  const heldTasks = useRef<TaskItem[] | null>(null);
  const liveTasks = useTaskStore((s) => (needed.tasks && s.loadedThreadId === data.threadId ? s.tasks : null));
  if (needed.tasks) heldTasks.current = liveTasks;
  const tasks = heldTasks.current;
  const recall = useRecallBindings(data, state.current, needed.recall);
  const [git, setGit] = useState<{ id: string; data?: GitData; load: string }>({ id: '', load: 'loading' });
  const [generation, setGeneration] = useState(0);
  const [native, setNative] = useState<{
    load: string;
    reviews: ThreadNativeReviewRunV1[];
    nativeTargets: { catId: string }[];
  }>({ load: 'loading', reviews: [], nativeTargets: [] });
  useEffect(() => {
    if (!needed.tasks) return; // Once per needed conversation; task events update the existing store.
    const abort = new AbortController();
    setTaskError(null);
    void request<{ tasks: TaskItem[] }>(`/api/tasks?threadId=${encodeURIComponent(data.threadId)}&kind=work`, {
      signal: abort.signal,
    }).then(
      ({ tasks }) => {
        if (!abort.signal.aborted) useTaskStore.getState().setTasks(tasks, data.threadId);
      },
      (error: Error) => {
        if (!abort.signal.aborted) setTaskError(error);
      },
    );
    return () => abort.abort();
  }, [needed.tasks, data.threadId]);
  const nativePending = useRef(false);
  const nativeRead = async (signal?: AbortSignal) => {
    const result = await request<{ reviews: ThreadNativeReviewRunV1[]; nativeTargets: { catId: string }[] }>(
      `/api/threads/${encodeURIComponent(data.threadId)}/reviews/native`,
      { signal },
    );
    if (!signal?.aborted) setNative({ ...result, load: '' });
    return result.reviews;
  };
  useEffect(() => {
    if (!needed.native) return; // Periodic: native review progress while projected.
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      clearTimeout(timer);
      if (document.hidden) return;
      try {
        const reviews = await nativeRead(abort.signal);
        if (
          !abort.signal.aborted &&
          reviews.some((review) => review.status === 'running' || review.status === 'queued')
        )
          timer = setTimeout(read, 5000);
      } catch {
        if (!abort.signal.aborted) setNative({ load: 'error', reviews: [], nativeTargets: [] });
      }
    };
    void read();
    document.addEventListener('visibilitychange', read);
    return () => {
      abort.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', read);
    };
  }, [needed.native, data.threadId, generation]);
  const refresh = useCallback(() => setGeneration((n) => n + 1), []);
  useEffect(() => {
    const abort = new AbortController();
    const worktree = workspace.worktrees.find((entry) => entry.id === workspace.worktreeId);
    if (!needed.git || !worktree) return;
    const id = worktree.id;
    if (worktree.head === 'nogit') {
      setGit({ id, load: '' });
      return;
    }
    setGit((current) => (current.id === id ? current : { id, load: 'loading' }));
    const query = new URLSearchParams({ worktreeId: id });
    void Promise.all([
      request<GitData['status']>(`/api/workspace/git-status?${query}`, { signal: abort.signal }),
      request<{ commits: GitCommit[] }>(`/api/workspace/git-log?${query}&limit=20`, { signal: abort.signal }),
      request<GitData['health']>(`/api/workspace/git-health?${query}`, { signal: abort.signal }),
    ])
      .then(async ([status, log, health]) => {
        const [commits, patch] = await Promise.all([
          Promise.all(
            log.commits.map(async (commit) => ({
              ...commit,
              files: (
                await request<CommitDetail>(`/api/workspace/git-show?${query}&hash=${commit.hash}`, {
                  signal: abort.signal,
                })
              ).files,
            })),
          ),
          request<WorkspacePatch>(`/api/workspace/diff?${query}`, { signal: abort.signal }),
        ]);
        if (!abort.signal.aborted) {
          setGit({ id, data: { status, log: { commits }, health }, load: '' });
          setPatch({ id, data: patch, parsed: parseUnifiedDiff(patch.diff) });
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setGit({ id, load: 'error' });
      });
    return () => abort.abort();
  }, [needed.git, workspace.worktreeId, workspace.worktrees, generation]);
  const fileScope = JSON.stringify([opened?.worktreeId, opened?.file.path]);
  useEffect(() => {
    const file = opened?.file,
      worktreeId = opened?.worktreeId;
    let current = true;
    if (!needed.file || !file || !worktreeId) return;
    setFileInfo((current) => (current.scope === fileScope ? current : { scope: fileScope, load: 'loading' }));
    void contentFileInfo({ kind: 'workspace', worktreeId, path: file.path })
      .then((info) => {
        if (current) setFileInfo({ scope: fileScope, load: '', info });
      })
      .catch(() => {
        if (current) setFileInfo({ scope: fileScope, load: 'error' });
      });
    return () => {
      current = false;
    };
  }, [needed.file, fileScope, opened?.file.sha256]);
  const action = async (name: string, args: Record<string, string>) => {
    if (name === 'projectBrowse') {
      ++completionRead.current;
      picker.current = { ...picker.current, completions: { prefix: '', entries: [] } };
      const [directory, drives] = await Promise.all([
        readDirectory(args.path),
        request<{ drives: { label: string; path: string }[] }>('/api/projects/drives'),
      ]);
      picker.current = { ...picker.current, browse: directory };
      picker.current = { ...picker.current, drives: drives.drives };
      publishPicker((n) => n + 1);
      return { directory };
    }
    if (name === 'projectDirectory') {
      await readDirectory(args.path);
      return true;
    }
    if (name === 'projectMkdir') {
      const result = await write<{ createdPath: string }>('/api/projects/mkdir', {
        parentPath: args.path,
        name: args.name,
      });
      await readDirectory(args.path);
      return result;
    }
    if (name === 'cafePathComplete') {
      const ticket = ++completionRead.current;
      const result = await request<{ entries: ProjectDirectory['entries'] }>(
        '/api/projects/complete?' + new URLSearchParams({ prefix: args.prefix, cwd: args.cwd, limit: '10' }),
      );
      if (ticket === completionRead.current) {
        picker.current = { ...picker.current, completions: { prefix: args.prefix, entries: result.entries } };
        publishPicker((n) => n + 1);
      }
      return true;
    }
    if (name === 'cafeProjectPrepare' || name === 'cafeProjectClone') {
      if (name === 'cafeProjectClone') {
        await write('/api/projects/setup', { projectPath: args.path, mode: 'clone', gitCloneUrl: args.gitCloneUrl });
      } else if (args.op !== 'refresh') {
        await write(
          args.op === 'init'
            ? '/api/projects/setup'
            : '/api/projects/bootstrap' + (args.op === 'later' ? '/snooze' : ''),
          { projectPath: args.path, ...(args.op === 'init' ? { mode: 'init' } : {}) },
        );
      }
      await readProject(args.path);
      return true;
    }
    if (await execution.action(name, args)) return true;
    if (await recall.action(name, args)) return true;
    if (
      ['fileDraft', 'fileCancel', 'fileSave', 'fileConflict'].includes(name) &&
      args.id !== (opened!.file.absolutePath ?? opened!.file.path)
    )
      throw new Error('文件来源已变化，请重新读取');
    switch (name) {
      case 'taskCreate': {
        await write<TaskItem>('/api/tasks', {
          threadId: data.threadId,
          title: args.title,
          why: args.why,
          ownerCatId: args.owner || null,
          createdBy: 'user',
        });
        const result = await request<{ tasks: TaskItem[] }>(
          `/api/tasks?${new URLSearchParams({ threadId: data.threadId })}`,
        );
        useTaskStore.getState().setTasks(result.tasks, data.threadId);
        return true;
      }
      case 'taskStatus': {
        const task = tasks?.find((t) => t.id === args.id);
        if (!task) throw new Error('任务已变化，请重新读取');
        const status = { todo: 'doing', doing: 'blocked', blocked: 'done', done: 'todo' }[task.status];
        const next = await write<TaskItem>(
          `/api/tasks/${encodeURIComponent(task.id)}`,
          { status, expectedOwnerRevision: task.ownerRevision ?? 0 },
          'PATCH',
        );
        useTaskStore.getState().updateTask(next);
        return true;
      }
      case 'wcReviewStart': {
        if (nativePending.current) return true;
        const r = state.current.review;
        let target: ThreadNativeReviewTarget;
        if (r.target === 'base') target = { kind: 'base_branch', branch: r.base.trim() };
        else if (r.target === 'sha') target = { kind: 'commit', sha: r.sha.trim() };
        else if (r.target === 'ask') target = { kind: 'custom', instructions: r.ask.trim() };
        else target = { kind: 'uncommitted_changes' };
        if (Object.values(target).some((v) => !v)) throw new Error('请补全审查目标');
        if (native.load || !native.nativeTargets.length) throw new Error('原生审查会话不可用，请重新读取');
        const catId = args.catId || (native.nativeTargets.length === 1 ? native.nativeTargets[0].catId : '');
        if (!native.nativeTargets.some((c) => c.catId === catId)) throw new Error('请选择原生审查会话');
        nativePending.current = true;
        try {
          await write(`/api/threads/${encodeURIComponent(data.threadId)}/reviews/native`, {
            target,
            delivery: r.mode === 'session' ? 'inline' : 'detached',
            catId,
          });
          await nativeRead();
        } finally {
          nativePending.current = false;
        }
        return true;
      }
      case 'fileOpen': {
        const worktreeId = args.w || workspace.worktreeId,
          path = args.p;
        if (!path) throw new Error('缺少文件路径');
        if (!worktreeId) throw new Error('请先选择工作区');
        if (worktreeId !== workspace.worktreeId) {
          const { useChatStore } = await import('@/stores/chatStore');
          useChatStore.getState().setWorkspaceWorktreeId(worktreeId);
        }
        setFileTarget({ worktreeId, path });
        return true;
      }
      case 'fileEdit':
        fileEdits.current[fileScope] ??= {
          content: opened!.file.content,
          original: opened!.file.content,
          baseSha256: opened!.file.sha256,
        };
        await editing.handleToggleEdit();
        return true;
      case 'fileDraft':
        fileEdits.current = {
          ...fileEdits.current,
          [fileScope]: { ...fileEdits.current[fileScope]!, content: args.content },
        };
        publishDrafts((n) => n + 1);
        return true;
      case 'fileCancel':
        delete fileEdits.current[fileScope];
        editing.setEditMode(false);
        editing.setSaveError(null);
        return true;
      case 'fileDrop':
        fileEdits.current = {};
        publishDrafts((n) => n + 1);
        editing.setEditMode(false);
        editing.setSaveError(null);
        return true;
      case 'fileSave': {
        const receipt = await editing.handleSave(fileEdits.current[fileScope].content, { baseSha256: args.baseSha256 });
        if (receipt) {
          delete fileEdits.current[fileScope];
          editing.setEditMode(false);
        }
        return true;
      }
      case 'fileConflict': {
        const worktreeId = opened!.worktreeId,
          path = opened!.file.path;
        const file = await request<FileData>(`/api/workspace/file?${new URLSearchParams({ worktreeId, path })}`);
        if (args.op === 'reload') {
          fileEdits.current = {
            ...fileEdits.current,
            [fileScope]: { content: file.content, original: file.content, baseSha256: file.sha256 },
          };
          setOpened({ worktreeId, file });
          editing.setSaveError(null);
        } else await action('fileSave', { id: args.id, baseSha256: file.sha256 });
        return true;
      }
      case 'fileChildren':
        await workspace.fetchSubtree(args.p.replace(/\/$/, ''));
        return true;
      case 'fileSearch':
        state.current.q = args.q;
        await fileSearch.search(
          args.q,
          state.current.qMode === 'name' ? 'filename' : state.current.qMode === 'content' ? 'content' : 'all',
        );
        return true;
      case 'worktree': {
        const { useChatStore } = await import('@/stores/chatStore');
        useChatStore.getState().setWorkspaceWorktreeId(args.v);
        return true;
      }
      case 'fileAction':
        await runContentFileAction(
          { kind: 'workspace', worktreeId: args.worktreeId, path: args.path },
          args.op as 'open' | 'reveal',
        );
        return true;
      case 'fileCreate':
        await changeFile(args.kind === 'dir' ? '/api/workspace/dir/create' : '/api/workspace/file/create', {
          path: args.path,
          ...(args.kind === 'dir' ? {} : { content: '' }),
        });
        return true;
      case 'fileRename':
        await changeFile('/api/workspace/file/rename', {
          oldPath: args.path,
          newPath: args.path.slice(0, args.path.lastIndexOf('/') + 1) + args.v,
        });
        return true;
      case 'fileDelete':
        await changeFile('/api/workspace/file', { path: args.path }, 'DELETE');
        return true;
      case 'fileUpload': {
        const owner = await editToken(),
          file = args.file as unknown as File;
        const upload = async (overwrite: boolean) => {
          const form = new FormData();
          form.append('worktreeId', owner.worktreeId);
          form.append('path', file.name);
          form.append('editSessionToken', owner.token);
          form.append('file', file);
          return apiFetch('/api/workspace/upload' + (overwrite ? '?overwrite=true' : ''), {
            method: 'POST',
            body: form,
          });
        };
        let response = await upload(false);
        if (response.status === 409) {
          if (!(await window.clowderChat.confirm('fileOverwrite', { name: file.name }))) return true;
          response = await upload(true);
        }
        if (!response.ok) throw new Error('文件上传未完成');
        await workspace.fetchTree();
        return true;
      }
      case 'refresh':
        if (args.k === 'files') {
          await workspace.fetchTree();
          return true;
        }
        if (args.k === 'tasks') {
          const result = await request<{ tasks: TaskItem[] }>(
            `/api/tasks?${new URLSearchParams({ threadId: data.threadId })}`,
          );
          useTaskStore.getState().setTasks(result.tasks, data.threadId);
          return true;
        }
        if (args.k === 'git') {
          refresh();
          return true;
        }
        return false;
      default:
        return false;
    }
  };
  const rawData = useMemo(
    () => ({
      projectPicker: picker.current,
      opened,
      fileInfo,
      fileEdits: fileEdits.current,
      editing: {
        editMode: editing.editMode,
        isTokenValid: editing.isTokenValid,
        canEdit: editing.canEdit,
        saveError: editing.saveError,
      },
      patch,
      tasks,
      taskError,
      git,
      native,
      execution: execution.data,
      recall: recall.data,
      fileSearch: { results: fileSearch.results, loading: fileSearch.loading, error: fileSearch.error },
      workspace: {
        worktreeId: workspace.worktreeId,
        worktrees: workspace.worktrees,
        tree: workspace.tree,
        loading: workspace.loading,
        error: workspace.error,
      },
    }),
    [
      picker.current,
      opened,
      fileInfo,
      fileEdits.current,
      editing.editMode,
      editing.isTokenValid,
      editing.canEdit,
      editing.saveError,
      patch,
      tasks,
      taskError,
      git,
      native,
      execution.data,
      recall.data,
      fileSearch.results,
      fileSearch.loading,
      fileSearch.error,
      workspace.worktreeId,
      workspace.worktrees,
      workspace.tree,
      workspace.loading,
      workspace.error,
    ],
  );
  return {
    state: state.current,
    action,
    refresh,
    workspace,
    opened,
    data: rawData,
  };
}
