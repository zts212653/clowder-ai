import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { createRoot } from 'react-dom/client';
import { ChatContainerHeader } from '@/components/ChatContainerHeader';
import { ChatInput } from '@/components/ChatInput';
import { ExecutionRow } from '@/components/execution-row/ExecutionRow';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { ThreadExecutionLayer } from '@/components/thread-chat/ThreadExecutionLayer';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import type { QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import '@/app/cat-persona-tokens.css';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/shell-v2.css';

/**
 * F322 original-B COMPONENT PREVIEW fixture — the REAL ExecutionRow, ExecutionRowPanel, QueueEntryRow, CatAvatar,
 * ForceResetDialog and the real stores, on a column the width of the reading column. It is not a production mount:
 * ChatInput / Header mount points are separate serial hunks. Only the registry request (`/api/cats`) and the avatar
 * files are answered by the journey; every other request is recorded by it, never sent anywhere.
 *
 * `?s=<scene>` seeds one of the design's states. `window.__row` lets the journey read what the stores hold.
 *
 * `?mount=1` renders the footer as the app now mounts it: the REAL ChatContainerHeader, ThreadExecutionLayer and
 * ChatInput one above the other, in whichever shell the stored preference says (v2 shows the one row, the title ⌄ and the
 * stop as the composer's last control; classic keeps the old bar, the old "replying… cancel" bar and the stop first).
 */
const THREAD = 'thread-row';
const NOW = Date.now();

primeCoCreatorConfigCache({
  name: 'You',
  aliases: [],
  mentionPatterns: ['@co-creator'],
  color: { primary: '#555555', secondary: '#eeeeee' },
});

function run(catId: string, over: Partial<ActiveExecutionProjection> = {}): ActiveExecutionProjection {
  return {
    executionId: `exec-${catId}`,
    threadId: THREAD,
    threadTitle: 'preview',
    catId,
    kind: 'live_invocation',
    startedAt: NOW - 125_000,
    cancelability: {
      state: 'cancelable',
      target: { kind: 'live_invocation', threadId: THREAD, catId, executionId: `exec-${catId}` },
    },
    ...over,
  };
}

function entry(id: string, createdAt: number, over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id,
    threadId: THREAD,
    userId: 'u',
    content: `请帮我看看这个 PR 的第 ${id} 处改动是否合理`,
    messageId: `m-${id}`,
    mergedMessageIds: [],
    source: 'user',
    targetCats: ['opus'],
    intent: 'execute',
    status: 'queued',
    createdAt,
    recoveryActions: [
      {
        id: `w-${id}`,
        entryId: id,
        kind: 'withdraw',
        request: { method: 'DELETE', path: `/api/threads/${THREAD}/queue/${id}` },
      },
    ],
    ...over,
  };
}

const STUCK = entry('stuck', NOW - 10_000, {
  status: 'processing',
  recoveryActions: [
    {
      id: 'queue-force-reset:stuck:1',
      entryId: 'stuck',
      kind: 'force_reset',
      request: { method: 'POST', path: `/api/threads/${THREAD}/force-reset` },
    },
  ],
});

interface Scene {
  runs: ActiveExecutionProjection[];
  queue: QueueEntry[];
  paused?: boolean;
  status?: Record<string, string>;
  pending?: boolean;
  legacy?: boolean;
}

const SCENES: Record<string, () => Scene> = {
  working: () => ({ runs: [run('opus')], queue: [] }),
  queue: () => ({ runs: [run('opus')], queue: [entry('1', NOW - 3), entry('2', NOW - 2)] }),
  several: () => ({
    runs: [run('opus'), run('codex'), run('gemini')],
    queue: [1, 2, 3, 4, 5].map((n) => entry(String(n), NOW - 10 + n)),
  }),
  silent: () => ({ runs: [run('opus')], queue: [], status: { opus: 'suspected_stall' } }),
  stopping: () => ({ runs: [run('opus')], queue: [], pending: true }),
  blocked: () => ({
    runs: [
      run('opus', {
        kind: 'managed_command',
        activity: 'full_gate',
        cancelability: { state: 'not_cancelable', reason: 'foreign_principal' },
      }),
    ],
    queue: [],
  }),
  unverified: () => ({ runs: [], queue: [], legacy: true }),
  stuck: () => ({ runs: [], queue: [STUCK, entry('a', NOW - 3), entry('b', NOW - 2)] }),
  paused: () => ({ runs: [], queue: [entry('1', NOW - 3), entry('2', NOW - 2), entry('3', NOW - 1)], paused: true }),
};

function seed(name: string) {
  const scene = (SCENES[name] ?? SCENES.working)();
  const executions = useActiveExecutionStore.getState();
  executions.reset();
  if (!scene.legacy) {
    const version = executions.beginHydration(THREAD, '/preview');
    useActiveExecutionStore
      .getState()
      .applySnapshot(THREAD, version, { projectPath: '/preview', executions: scene.runs });
  }
  if (scene.pending) {
    useActiveExecutionStore.setState({
      cancelPendingByKey: Object.fromEntries(scene.runs.map((r) => [activeExecutionKey(r), true as const])),
    });
  }
  const live = scene.runs.filter((r) => r.kind === 'live_invocation');
  useChatStore.setState({
    currentThreadId: THREAD,
    messages: [],
    threadStates: {},
    catInvocations: {},
    catStatuses: scene.status ?? {},
    activeInvocations: scene.legacy
      ? { legacy: { catId: 'opus', startedAt: NOW } }
      : Object.fromEntries(live.map((r) => [r.executionId, { catId: r.catId, startedAt: r.startedAt }])),
    hasActiveInvocation: Boolean(scene.legacy) || live.length > 0,
    queue: scene.queue,
    queuePaused: scene.paused ?? false,
    queuePauseReason: scene.paused ? 'canceled' : undefined,
  } as never);
}

seed(new URLSearchParams(window.location.search).get('s') ?? 'working');

(window as unknown as { __row: unknown }).__row = {
  toasts: () => useToastStore.getState().toasts.map((t) => ({ title: t.title, type: t.type })),
  queueIds: () => useChatStore.getState().queue.map((e) => e.id),
};

function Preview() {
  return (
    <div data-testid="column" style={{ width: 720, margin: '24px auto', border: '1px solid #8884', borderRadius: 12 }}>
      <div data-testid="thread-header" style={{ padding: '8px 16px', fontSize: 12, opacity: 0.6 }}>
        组件预览（隔离夹具）· thread header
      </div>
      <div data-testid="chat-body" style={{ padding: 16, height: 380, fontSize: 13, opacity: 0.8 }}>
        <p>（对话区域）展开面板时，它应该从下面这一行往上浮在这段文字上面，而不是把它推开。</p>
        <p>message one … message two … message three …</p>
      </div>
      {/* The row sits directly above the composer, at the bottom — the panel opens upward over the chat. */}
      <ExecutionRow threadId={THREAD} />
    </div>
  );
}

function MountedPreview() {
  // ThreadChatSurface tells its composer which presentation it is hosted in; the preview does the same.
  const presentation = useShellPresentation();
  return (
    <div
      data-testid="column"
      style={{ width: 760, margin: '16px auto', border: '1px solid #8884', borderRadius: 12, overflow: 'hidden' }}
    >
      <div data-testid="thread-header">
        <ChatContainerHeader
          sidebarOpen
          onToggleSidebar={() => {}}
          threadId={THREAD}
          viewMode="single"
          onToggleViewMode={() => {}}
          statusPanelOpen={false}
          onToggleStatusPanel={() => {}}
        />
      </div>
      <div data-testid="chat-body" style={{ padding: 16, height: 200, fontSize: 13, opacity: 0.8 }}>
        <p>（对话区域）</p>
      </div>
      <ThreadExecutionLayer threadId={THREAD} />
      <ChatInput
        presentation={presentation}
        threadId={THREAD}
        onSend={() => {}}
        hasActiveInvocation={useChatStore.getState().hasActiveInvocation}
      />
    </div>
  );
}

const mounted = new URLSearchParams(window.location.search).get('mount') === '1';
// The app marks the document `data-shell="v2"` while the new shell is chosen; its tokens and the composer/row column
// rules in shell-v2.css hang off that attribute. Mirror it, so the mounted scenes lay out as the app does.
if (mounted && window.localStorage.getItem('cat-cafe:shell-presentation') === 'v2') {
  document.documentElement.setAttribute('data-shell', 'v2');
}
createRoot(document.getElementById('root') as HTMLElement).render(mounted ? <MountedPreview /> : <Preview />);
