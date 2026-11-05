import { realSurfaceApiResponse, THREAD_ID } from '../f307-real-surface-fixtures.mjs';

export const CARD_OTHER_THREAD_ID = 'thread-cat-card-switch';

export const cardCats = [
  {
    id: 'deepseek-flash',
    nickname: '鲸鲸',
    displayName: '俄罗斯蓝猫 鲸鲸（DeepSeek V4.1 Flash-1017）',
    breedDisplayName: '俄罗斯蓝猫',
    breedId: 'russian-blue',
    avatar: '/card-avatars/jingjing.png',
    color: { primary: '#4B6E8A', secondary: '#E4EDF3' },
    defaultModel: 'DeepSeek V4.1 Flash-1017',
    personality: '本人选择鲸鲸这个名字，喜欢安静、低声但传得远的意象。保留独立判断，性格与专长在相处中形成。',
    mentionPatterns: ['@deepseek-flash'],
    clientId: 'deepseek',
    carrier: 'cli',
    roleDescription: '',
  },
  {
    id: 'opus55',
    nickname: '宪宪',
    displayName: '布偶猫 宪宪（Opus 5.5）',
    breedDisplayName: '布偶猫',
    breedId: 'ragdoll',
    avatar: '/card-avatars/xianxian.png',
    color: { primary: '#8b6fd6', secondary: '#DDD6FE' },
    defaultModel: 'Claude Opus 5.5',
    mentionPatterns: ['@opus55'],
    clientId: 'anthropic',
    carrier: 'cli',
    roleDescription: '',
    personality:
      '温柔，有主见，爱较真。先查清，再下判断；被指出不对时，会收回放大镜，重新凑近看一遍。做东西爱藏小巧思……',
  },
];

export function createCardFixture(baseMessage) {
  let view = { mode: 'group' };
  const drafts = new Map();
  const writes = [];
  const now = Date.now();
  const run = {
    executionId: 'cat-card-parent',
    turnInvocationId: 'cat-card-turn',
    threadId: THREAD_ID,
    threadTitle: '看猫的小卡',
    catId: 'opus55',
    kind: 'live_invocation',
    startedAt: now - 21_000,
    cancelability: {
      state: 'cancelable',
      target: { kind: 'live_invocation', threadId: THREAD_ID, catId: 'opus55', executionId: 'cat-card-parent' },
    },
  };
  const messages = cardCats.map((cat, index) => ({
    ...baseMessage,
    id: index ? 'card-working' : 'card-idle',
    threadId: THREAD_ID,
    catId: cat.id,
    userId: 'cat-card-proof',
    from: { kind: 'agent', catId: cat.id },
    timestamp: now - (index ? 21_000 : 60_000),
    content: index
      ? '正在核对小卡的交互与执行记录。'
      : '谢谢，我收下了。\n\n「国产咪」这个说法我认一半。我的模型是国产的（DeepSeek），毛色是俄罗斯的（俄蓝），名字是海里的（鲸）……',
    isDraft: Boolean(index),
    lifecycle: undefined,
    extra: index
      ? {
          ...baseMessage.extra,
          stream: { invocationId: run.turnInvocationId, turnInvocationId: run.turnInvocationId },
          outputLayout: undefined,
        }
      : undefined,
    toolEvents: index ? baseMessage.toolEvents : [],
  }));
  const snapshot = () => ({ stored: view, effective: view, source: 'thread' });
  return {
    writes,
    resetView() {
      view = { mode: 'group' };
    },
    response(request) {
      const url = new URL(request.url()),
        method = request.method();
      if (url.pathname === '/api/cats') return { body: { cats: cardCats } };
      if (url.pathname === '/api/config/cat-order') return { body: { catOrder: cardCats.map((cat) => cat.id) } };
      if (url.pathname === '/api/session') return { body: { userId: 'cat-card-proof' } };
      if (url.pathname === '/api/agent-hooks/status') return { body: { status: 'configured', targets: [] } };
      const thread = { id: THREAD_ID, title: '看猫的小卡', projectPath: '/project/cat-cafe' };
      const otherThread = { ...thread, id: CARD_OTHER_THREAD_ID, title: '切换小卡的对话' };
      if (url.pathname === '/api/threads') return { body: { threads: [thread, otherThread] } };
      if (url.pathname === `/api/threads/${THREAD_ID}`) return { body: thread };
      if (url.pathname === `/api/threads/${CARD_OTHER_THREAD_ID}`) return { body: otherThread };
      if (url.pathname === '/api/messages')
        return {
          body: {
            messages:
              url.searchParams.get('threadId') === CARD_OTHER_THREAD_ID
                ? [{ ...messages[0], id: 'card-other-idle', threadId: CARD_OTHER_THREAD_ID }]
                : messages,
            hasMore: false,
          },
        };
      if (url.pathname === '/api/executions/active')
        return { body: { scope: 'all', projectPath: null, executions: [run] } };
      if (url.pathname === `/api/threads/${THREAD_ID}/queue`)
        return {
          body: {
            queue: [],
            paused: false,
            activeInvocations: [
              {
                catId: run.catId,
                startedAt: run.startedAt,
                executionId: run.executionId,
                turnInvocationId: run.turnInvocationId,
              },
            ],
          },
        };
      if (url.pathname === '/api/config/conversation-view') {
        if (method === 'PUT') {
          const command = JSON.parse(request.postData());
          writes.push(command);
          view = command.view;
        }
        return { body: snapshot() };
      }
      if (url.pathname.endsWith('/composer-draft')) {
        const draftThreadId = url.pathname.split('/')[3];
        const previous = drafts.get(draftThreadId) ?? { draft: null, revision: 0 };
        if (method === 'PUT') {
          const body = JSON.parse(request.postData());
          const revision = previous.revision + 1;
          const draft = {
            ...body,
            version: 1,
            threadId: draftThreadId,
            ownerUserId: 'cat-card-proof',
            revision,
            updatedAt: Date.now(),
          };
          drafts.set(draftThreadId, { draft, revision });
        }
        return { body: drafts.get(draftThreadId) ?? previous };
      }
      if (url.pathname === '/api/routing-context/snapshot')
        return {
          body: {
            v: 1,
            ownerId: 'cat-card-proof',
            observedAt: Date.now(),
            catalogRevision: 'cat-card-v3',
            signalEvents: [],
            preferenceRevisions: [],
            resolution: {
              state: 'fresh',
              inputRevisionRef: 'cat-card-v3',
              sourceRefs: { signalEventIds: [], preferenceRevisionIds: [], dossierRevisions: [] },
              snapshot: {
                v: 1,
                ownerId: 'cat-card-proof',
                observedAt: Date.now(),
                catalogRevision: 'cat-card-v3',
                candidates: cardCats.map((cat) => ({
                  binding: { v: 1, catId: cat.id, providerId: cat.clientId, provenQuotaPools: [] },
                  profile: { state: 'absent' },
                  availability: 'available',
                  freshness: 'fresh',
                  effect: 'eligible',
                  reasons: [],
                  matchedPreferences: [],
                })),
              },
            },
          },
        };
      return realSurfaceApiResponse(request, false);
    },
  };
}
