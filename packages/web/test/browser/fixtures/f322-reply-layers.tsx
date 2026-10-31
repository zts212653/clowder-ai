import { createRoot } from 'react-dom/client';
import { CapabilityTipStrip } from '@/components/CapabilityTipStrip';
import { CatHueInjector } from '@/components/CatHueInjector';
import { ChatMessage } from '@/components/ChatMessage';
import { CoCreatorHueInjector } from '@/components/CoCreatorHueInjector';
import { MessageActions } from '@/components/MessageActions';
import { MessageViewportBoundary } from '@/components/MessageViewportBoundary';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { ThemeApplier } from '@/components/ThemeApplier';
import { ThemeProvider } from '@/components/ThemeProvider';
import { AttentionClusterHeader } from '@/components/ThreadSidebar/AttentionCluster';
import { useCatData } from '@/hooks/useCatData';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage as ChatMessageData, ToolEvent } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { useThemeStore } from '@/stores/themeStore';
import { ReadingActions } from './f322-reading-actions';
import { subexecutionSceneMessages } from './f322-subexecution-scenes';
import { ActualProbe, themeApplied } from './f322-theme-applied';
import '@/app/cat-persona-tokens.css';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/shell-v2.css';

/**
 * F322 B §1.16 probe fixture: the REAL ChatMessage, ReplyLayers (last line + record), MessageViewportBoundary, CatNameplate and the
 * REAL theme pipeline, on one reply per state the design names. Nothing here is drawn by the fixture: every state is a message
 * (or store fact) the app produces, and `window.__replies.applied()` resolves once the theme is on the page.
 */
primeCoCreatorConfigCache({
  name: 'Fixture Owner',
  aliases: [],
  mentionPatterns: ['@fixture-owner'],
  color: { primary: '#555555', secondary: '#eeeeee' },
});

const T0 = Date.UTC(2026, 9, 5, 3, 0);
const tool = (id: string, label: string, detail?: string): ToolEvent => ({
  id,
  type: 'tool_use',
  label,
  detail,
  timestamp: T0,
});
const result = (id: string, detail: string, status: 'completed' | 'error' = 'completed'): ToolEvent => ({
  id: `${id}-result`,
  type: 'tool_result',
  label: `${id} result`,
  detail,
  status,
  timestamp: T0 + 1,
});
const run = (turn: string) => ({ stream: { invocationId: `parent-${turn}`, turnInvocationId: turn } });
const response = (
  id: string,
  catId: string,
  status: Extract<NonNullable<ChatMessageData['lifecycle']>, { kind: 'response' }>['status'],
): Extract<NonNullable<ChatMessageData['lifecycle']>, { kind: 'response' }> => ({
  kind: 'response',
  orderKey: `${T0}:${id}`,
  invocationId: id,
  targetId: catId,
  inputEntryIds: [],
  inputMessageIds: [],
  status,
  startedAt: T0,
  ...(status === 'processing' ? {} : { completedAt: T0 + 1000 }),
});
const base = (id: string, catId: string, over: Partial<ChatMessageData>): ChatMessageData => ({
  from: { kind: 'agent', catId: catId },
  id,
  type: 'assistant',
  catId,
  origin: 'stream',
  content: '先看一下现状，再改。',
  timestamp: T0,
  extra: run(id),
  ...over,
});

const LONG_COMMAND = `pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/ChatMessage-reply-layers.test.tsx ${'--reporter=verbose '.repeat(6)}`;
const messages: ChatMessageData[] = [
  base('r-writing', 'codex', { isStreaming: true, toolEvents: undefined, content: '先看一下现状' }),
  base('r-working', 'opus', {
    isStreaming: true,
    toolEvents: [tool('w1', 'Bash', JSON.stringify({ command: 'pnpm test' }))],
    content: '我先跑一遍测试。',
  }),
  base('r-working-long', 'glm52', {
    isStreaming: true,
    toolEvents: [tool('l1', 'Bash', JSON.stringify({ command: LONG_COMMAND }))],
    content: '长命令不能把别的东西挤出这一行。',
  }),
  base('r-quiet', 'gemini', {
    isStreaming: true,
    toolEvents: [tool('q1', 'Read', JSON.stringify({ file_path: '/app/src/login.tsx' }))],
    content: '在读登录页。',
    extra: run('turn-quiet'),
  }),
  base('r-durable-processing', 'opus', {
    // The named response remains processing even before this browser receives a stream.
    isStreaming: false,
    lifecycle: response('turn-processing', 'opus', 'processing'),
  }),
  base('r-failed', 'codex', {
    lifecycle: response('turn-failed', 'codex', 'failed'),
    toolEvents: [tool('f1', 'Bash', JSON.stringify({ command: 'pnpm build' })), result('f1', 'exit 1', 'error')],
    content: '构建没过。',
    extra: {
      ...run('turn-failed'),
      cliDiagnostics: {
        publicSummary: '等待回复超时',
        publicHint: '',
        debugRef: { command: 'claude', exitCode: null, signal: null, invocationId: 'parent-turn-failed' },
        reasonCode: 'cli_response_timeout',
      },
    },
  }),
  base('r-stopped', 'gemini', {
    lifecycle: response('turn-stopped', 'gemini', 'canceled'),
    toolEvents: [tool('s1', 'Grep', JSON.stringify({ pattern: 'TODO' })), result('s1', '3 matches')],
    content: '搜到一半被停了。',
    extra: run('turn-stopped'),
  }),
  base('r-done', 'opus', {
    toolEvents: [
      tool('d1', 'Bash', JSON.stringify({ command: 'pnpm test' })),
      result('d1', 'exit 0'),
      tool('d2', 'Edit', JSON.stringify({ file_path: '/app/src/login.tsx' })),
      result('d2', 'edited'),
      tool('d3', 'Read', JSON.stringify({ file_path: '/app/src/missing.tsx' })),
      result('d3', 'no such file', 'error'),
    ],
    thinking: '先核对一下上一版的参数，再决定改哪里。',
    content: '改好了登录页。\n\n- 测试全过\n- 有一个文件不存在，已跳过',
    metadata: {
      provider: 'anthropic',
      model: 'claude-opus',
      usage: { inputTokens: 98_000, outputTokens: 2_100, cacheReadTokens: 49_000, costUsd: 0.32, durationMs: 402_000 },
    },
  }),
  base('r-rerouted', 'codex', {
    toolEvents: [tool('x1', 'Read', JSON.stringify({ file_path: '/a.ts' })), result('x1', 'ok')],
    content: '读完了。',
    metadata: { provider: 'openai', model: 'gpt-5.6-sol', servedModel: 'gpt-6-sol', usage: { durationMs: 12_000 } },
  }),
  base('r-plain', 'gemini', {
    origin: 'callback',
    toolEvents: undefined,
    content: '收到。',
    extra: { isExplicitPost: true },
  }),
  base('r-handoff-recall', 'opus', {
    lifecycle: {
      ...response('r-handoff-recall', 'opus', 'completed'),
      dispatchRefs: ['codex', 'gemini'].map((targetId, index) => ({
        targetId,
        phase: 'settled' as const,
        statusMessageId: `r-dispatch-failure-${index + 1}`,
        dispatchedAt: T0,
      })),
    },
    toolEvents: [
      tool('recall-1', 'mcp__cat_cafe_memory__cat_cafe_search_evidence', JSON.stringify({ query: 'F322' })),
      result('recall-1', 'Found 1 result(s): F322'),
    ],
    content: '我查完记忆，把两条并行工作交出去了。',
    metadata: { provider: 'anthropic', model: 'claude-opus', usage: { durationMs: 65_000 } },
  }),
  {
    from: { kind: 'system', service: 'a2a-routing' },
    id: 'r-handoff-route-1',
    type: 'system',
    content: '布偶猫 ⇉ 缅因猫（并行 1/2）',
    timestamp: T0 + 1,
    extra: {
      systemKind: 'a2a_routing',
      a2aRouting: {
        fromCatId: 'opus',
        targetCatId: 'codex',
        routing: { mode: 'parallel', index: 1, total: 2 },
      },
    },
  },
  {
    from: { kind: 'system', service: 'a2a-routing' },
    id: 'r-handoff-route-2',
    type: 'system',
    content: '布偶猫 ⇉ 暹罗猫（并行 2/2）',
    timestamp: T0 + 1,
    extra: {
      systemKind: 'a2a_routing',
      a2aRouting: {
        fromCatId: 'opus',
        targetCatId: 'gemini',
        routing: { mode: 'parallel', index: 2, total: 2 },
      },
    },
  },
  ...['codex', 'gemini'].map(
    (targetId, index): ChatMessageData => ({
      from: { kind: 'system', service: 'message-lifecycle' },
      id: `r-dispatch-failure-${index + 1}`,
      type: 'system',
      content: '成员暂不可用',
      timestamp: T0 + 1,
      lifecycle: {
        kind: 'delivery_failure',
        orderKey: `${T0 + 1}:${index}`,
        status: 'failed',
        sourceEntryId: `entry-${index}`,
        inputMessageId: 'r-handoff-recall',
        requestedTargets: [targetId],
        reason: 'no_available_target',
        createdAt: T0 + 1,
      },
    }),
  ),
  {
    from: { kind: 'system', service: 'message-lifecycle' },
    id: 'r-orphan-dispatch-failure',
    type: 'system',
    content: '唤起处理成员失败',
    timestamp: T0 + 2,
    lifecycle: {
      kind: 'delivery_failure',
      orderKey: `${T0 + 2}:orphan`,
      status: 'failed',
      sourceEntryId: 'entry-orphan',
      inputMessageId: 'r-source-not-in-timeline',
      requestedTargets: ['codex'],
      reason: 'no_available_target',
      createdAt: T0 + 2,
    },
  },
  ...(['running', 'canceled', 'succeeded'] as const).map((phase) =>
    base(`r-terminal-${phase}`, 'opus', {
      // A terminal reconciliation fact must win even while an old stream flag is still present.
      isStreaming: phase !== 'running',
      toolEvents: [tool(`terminal-${phase}`, 'Read')],
      lifecycle: {
        kind: 'response',
        orderKey: '1',
        invocationId: `terminal-${phase}`,
        targetId: 'opus',
        inputEntryIds: [],
        inputMessageIds: [],
        status: phase === 'running' ? 'processing' : phase === 'succeeded' ? 'completed' : phase,
        startedAt: T0,
      },
      extra: {
        ...run(`terminal-${phase}`),
      },
    }),
  ),
];

const activityProof = new URLSearchParams(window.location.search).has('activity');
if (activityProof) {
  messages.push(
    base('r-activity', 'codex', {
      timestamp: Date.now() - 133_000,
      isStreaming: true,
      content: '我在连续核对这几处。',
      toolEvents: [
        { ...tool('activity-0', 'Read', JSON.stringify({ file_path: '/app/ThreadItem.tsx' })), timestamp: Date.now() },
      ],
    }),
  );
}
const probeReplyCopy = new URLSearchParams(window.location.search).has('replyCopy');
const failureVisibility = new URLSearchParams(window.location.search).has('failureVisibility');
const failedMembers = [
  {
    id: 'failed-child',
    title: 'F317 C · 前台收件与长对话续接',
    projectPath: '/fixture',
    participants: ['codex'],
    lastActiveAt: T0,
    pinned: false,
    favorited: false,
    preferredCats: [],
    labels: [],
    systemKind: null,
    isHubThread: false,
    unreadCount: 12,
    hasUserMention: false,
    presence: { status: 'error' },
  },
] satisfies SidebarSnapshotRow[];
if (failureVisibility) {
  messages.push({
    from: { kind: 'system', service: 'agent-error' },
    id: 'r-network-error',
    type: 'system',
    content: 'Error: stream disconnected before completion',
    timestamp: T0,
    extra: {
      cliDiagnostics: {
        reasonCode: 'network_error',
        publicSummary: '网络连接失败',
        publicHint: '模型服务连接已中断。',
        debugRef: { command: 'codex app-server', exitCode: null, signal: null, invocationId: 'failed-primary' },
      },
    },
  });
}
if (new URLSearchParams(window.location.search).has('subagents')) {
  messages.splice(0, messages.length, ...subexecutionSceneMessages());
}
if (probeReplyCopy) {
  messages.push(
    base('r-copy-long', 'codex', {
      origin: 'callback',
      content: Array.from({ length: 35 }, (_, index) => `Original paragraph ${index}`).join('\n'),
    }),
    {
      from: { kind: 'user', userId: 'default-user' },
      id: 'r-copy-quote',
      type: 'user',
      content: '',
      timestamp: T0,
      contentBlocks: [
        {
          type: 'context_attachment',
          attachment: {
            v: 1,
            id: 'copy-quote',
            kind: 'quote',
            text: 'Original quoted text 原样保留',
            comment: 'Original comment 批注原文',
            source: { kind: 'cli_output', threadId: 'thread-replies', messageId: 'r-done', segmentId: 'stdout' },
          },
        },
      ],
    },
  );
}

useChatStore.setState({
  currentThreadId: 'thread-replies',
  ...(probeReplyCopy || activityProof ? { messages } : {}),
  threads: [
    {
      id: 'c-original',
      title: new URLSearchParams(window.location.search).has('longSource')
        ? 'Canonical source conversation with a long durable provenance title'
        : 'Canonical source conversation',
      createdAt: T0,
      projectPath: '/fixture',
      createdBy: 'owner-1',
      participants: [],
      lastActiveAt: T0,
    },
  ],
  catStatuses: { gemini: 'alive_but_silent' },
  catInvocations: { gemini: { invocationId: 'parent-turn-quiet', turnInvocationId: 'turn-quiet' } },
  globalBubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' },
});

declare global {
  interface Window {
    __replies: {
      applyTheme: (base: 'light' | 'dark') => void;
      applied: () => Promise<void>;
      setLanguage: typeof writeShellLanguage;
      appendTool: (label: string, args: Record<string, string>) => void;
    };
  }
}

window.__replies = {
  applyTheme(themeBase) {
    useThemeStore.getState().setActive(themeBase);
  },
  applied: themeApplied,
  setLanguage: writeShellLanguage,
  appendTool(label, args) {
    const current = useChatStore.getState().messages;
    useChatStore.setState({
      messages: current.map((message) => {
        if (message.id !== 'r-activity') return message;
        const events = message.toolEvents ?? [];
        return {
          ...message,
          toolEvents: [
            ...events,
            {
              id: `activity-${events.length}`,
              type: 'tool_use' as const,
              label,
              detail: JSON.stringify(args),
              timestamp: Date.now(),
            },
          ],
        };
      }),
    });
  },
};

function Thread() {
  const { getCatById } = useCatData();
  const activeMessages = useChatStore((state) => state.messages);
  const shown = activityProof ? activeMessages : messages;
  const width = Number(new URLSearchParams(window.location.search).get('w') ?? '720');
  return (
    <div
      data-testid="column"
      data-thread-chat-reading-column
      style={{ width, padding: '16px 20px', background: 'var(--shell-work)', color: 'var(--cafe-text)' }}
    >
      {activityProof && (
        <button type="button" onClick={() => window.__replies.appendTool('Grep', { pattern: 'ReplyLastLine' })}>
          下一次工具调用
        </button>
      )}
      {shown.map((message) => (
        <MessageViewportBoundary key={message.id}>
          <MessageActions message={message} threadId="thread-replies">
            <ChatMessage
              message={message}
              threadId="thread-replies"
              timelineMessages={shown}
              getCatById={getCatById}
              onEditCat={() => undefined}
            />
          </MessageActions>
        </MessageViewportBoundary>
      ))}
      {probeReplyCopy && (
        <div data-testid="copy-tip">
          <CapabilityTipStrip surface="assistant_stream_bubble" contexts={['thinking']} firstDelayMs={0} />
        </div>
      )}
      {probeReplyCopy && <textarea aria-label="Copy probe draft" defaultValue="Unsent draft 未发送" />}
      {failureVisibility && (
        <div data-testid="failed-group" style={{ width: 240 }}>
          <AttentionClusterHeader
            cluster={{
              anchor: 'group:failed',
              groupId: 'failed',
              rootThreadId: 'failed-child',
              title: 'F317',
              memberIds: ['failed-child'],
              searchText: '',
            }}
            members={failedMembers}
            displayTitle="F317"
            expanded={false}
            onToggle={() => undefined}
            onRename={() => undefined}
            onAdd={() => undefined}
            onMemberSort={() => undefined}
          />
        </div>
      )}
      <ReadingActions />
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing reply-layers fixture root');
if (window.localStorage.getItem('cat-cafe:shell-presentation') === 'v2') {
  document.documentElement.setAttribute('data-shell', 'v2');
}
createRoot(root).render(
  <ThemeProvider>
    <CatHueInjector />
    <CoCreatorHueInjector />
    <ThemeApplier />
    <ActualProbe />
    <Thread />
  </ThemeProvider>,
);
