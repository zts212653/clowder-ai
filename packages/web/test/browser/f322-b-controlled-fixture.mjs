/** Durable, explicit acceptance sample. It never starts a cat, shell command, Redis, or a real cancellation. */
export function createF322BControlledFixture(threadId) {
  const catId = 'codex61-sol';
  const startedAt = Date.now() - 12_000;
  const title = 'F322 受控验收样本 · 非真实猫执行';
  const live = {
    kind: 'live_invocation',
    executionId: 'sample-parent',
    turnInvocationId: 'sample-turn-exact',
    threadId,
    threadTitle: title,
    catId,
    startedAt,
    cancelability: {
      state: 'cancelable',
      target: { kind: 'live_invocation', threadId, catId, executionId: 'sample-parent' },
    },
  };
  const managed = {
    kind: 'managed_command',
    executionId: 'sample-hold-exact',
    activity: 'full_gate',
    threadId,
    threadTitle: title,
    catId,
    startedAt,
    cancelability: { state: 'cancelable', target: { kind: 'managed_command', taskId: 'sample-hold-exact' } },
  };
  const message = {
    from: { kind: 'agent', catId: catId },
    id: 'sample-live-message-exact',
    catId,
    content: 'F322 controlled live transcript: exact turn, original execution record.',
    origin: 'stream',
    isDraft: true,
    timestamp: startedAt,
    toolEvents: [
      {
        id: 'sample-tool-exact',
        type: 'tool_use',
        label: 'exec_command',
        detail: 'sample-only, never executed',
        timestamp: startedAt,
      },
    ],
    extra: { stream: { invocationId: 'sample-parent', turnInvocationId: 'sample-turn-exact' } },
  };
  const thread = {
    id: threadId,
    title,
    projectPath: '/f322-controlled-sample',
    createdBy: 'f322-sample-user',
    createdAt: startedAt - 1000,
    lastActiveAt: startedAt,
    preferredCats: [catId],
    participants: [catId],
  };
  let executions = [live];
  const calls = [];
  return {
    live,
    managed,
    message,
    calls,
    setExecutions(value) {
      executions = value;
    },
    response(url, method = 'GET') {
      calls.push(`${method} ${url.pathname}`);
      if (url.pathname === '/api/session') return { userId: 'f322-sample-user' };
      if (url.pathname === '/api/cats')
        return {
          cats: [
            {
              id: catId,
              nickname: '小太阳·砚砚',
              displayName: '缅因猫',
              variantLabel: 'GPT-6.1 Sol',
              color: { primary: '#5B8C5A', secondary: '#eeeeee' },
              mentionPatterns: ['@codex61-sol'],
              carrier: 'cli',
              clientId: 'openai',
              defaultModel: 'gpt-6.1-sol',
              avatar: '/avatars/family/codex61-sol.png',
              roster: { available: true },
            },
          ],
        };
      if (url.pathname === '/api/config/cat-order') return { catOrder: [catId] };
      if (url.pathname === '/api/debug/callback-auth')
        return {
          reasonCounts: {},
          toolCounts: {},
          byCat: {},
          recentSamples: [],
          totalFailures: 0,
          startedAt,
          uptimeMs: 1000,
          recent24h: { totalFailures: 0, byReason: {}, byTool: {}, byCat: {} },
        };
      if (url.pathname === '/api/threads') return { threads: [thread] };
      if (url.pathname === `/api/threads/${threadId}`) return thread;
      if (url.pathname === '/api/messages')
        return {
          messages: [
            {
              id: 'sample-explanation',
              content: '受控验收样本：消息和后台命令是固定数据；不会调用猫、执行命令或停止真实任务。',
              timestamp: startedAt - 1000,
            },
            message,
          ],
          hasMore: false,
        };
      if (url.pathname.endsWith('/queue'))
        return {
          queue: [],
          paused: false,
          activeInvocations: executions
            .filter((run) => run.kind === 'live_invocation')
            .map((run) => ({
              catId: run.catId,
              startedAt: run.startedAt,
              executionId: run.executionId,
              turnInvocationId: run.turnInvocationId,
            })),
        };
      if (url.pathname === '/api/executions/active') return { projectPath: thread.projectPath, executions };
      if (url.pathname === '/api/callbacks/hold-ball/sample-hold-exact/status')
        return {
          taskId: managed.executionId,
          catId,
          access: { lifecycleVisibility: 'full' },
          lifecycle: {
            mode: 'wake_when',
            managedCommand: { state: 'command_running', command: 'pnpm gate # 受控样本，不会执行', startedAt },
          },
        };
      if (url.pathname === '/api/callbacks/hold-ball/sample-hold-exact' && method === 'DELETE') {
        executions = executions.filter((run) => run.executionId !== managed.executionId);
        return { cancelled: true };
      }
      if (url.pathname.endsWith('/task-progress')) return { taskProgress: {} };
      if (url.pathname.endsWith('/freshness-closures')) return { closures: [], supplements: [] };
      if (url.pathname.endsWith('/artifacts')) return { threadId, artifacts: [] };
      if (url.pathname.endsWith('/invocations')) return { total: 0, invocations: [] };
      if (url.pathname === '/api/workspace/worktrees') return { worktrees: [] };
      return null;
    },
  };
}
