export const COMPANION_THREAD = 'f317-companion-original';
export const OTHER_THREAD = 'f317-original-work';
export const CAT = {
  id: 'codex61-sol',
  displayName: '砚砚',
  variantLabel: 'GPT-6.1 Sol',
  color: { primary: '#6b8f34', secondary: '#c8d8b5' },
  mentionPatterns: ['codex61-sol'],
  carrier: 'cli',
  clientId: 'openai',
  defaultModel: 'gpt-6.1-sol',
  avatar: '/avatars/codex.png',
  roleDescription: '陪伴者',
  personality: 'warm',
  roster: { family: 'maine-coon', roles: [], lead: false, available: true, evaluation: 'fixture' },
};
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=',
  'base64',
);
const message = (id, content, extra = {}) => ({
  id,
  threadId: COMPANION_THREAD,
  userId: 'fixture-owner',
  from: { kind: 'agent', catId: CAT.id },
  content,
  mentions: [],
  timestamp: 1791200000000 + id.length,
  metadata: { model: CAT.defaultModel, provider: 'openai' },
  extra: { isExplicitPost: true, ...extra },
});
const card = (id, title, actions) =>
  message(id, title, { rich: { v: 1, blocks: [{ id: `${id}-card`, kind: 'card', v: 1, title, actions }] } });
export function createEntryFixture(mode = 'missing') {
  const drafts = new Map();
  const config = {
    enabled: false,
    muted: true,
    displayName: '猫猫球',
    personaTone: '合成保存人设',
    dutyCatProfileId: CAT.id,
    proactivePolicy: 'quiet-badge',
    skin: 'xianxian-codex',
    ballSize: 84,
    behaviorEnabled: false,
    ballPosition: { x: 83, y: 127 },
  };
  const messages = [
    message('saved-history', '原伴随历史与消息 ID 保持不变'),
    {
      ...message('saved-image', '已保存图文'),
      contentBlocks: [
        { type: 'text', text: '已保存图文' },
        { type: 'image', url: '/uploads/f317-synthetic.png' },
      ],
    },
    card('navigation', '原记忆卡片', [
      {
        label: '查看原记录',
        action: 'concierge_peek',
        payload: { threadId: OTHER_THREAD, messageId: 'original-anchor' },
      },
    ]),
    card('relay', '原传话卡片', [
      {
        label: '确认原传话',
        action: 'concierge_relay',
        payload: {
          targetThreadId: OTHER_THREAD,
          targetCats: [CAT.id],
          originalText: '保留这段原话',
          sourceMessageId: 'saved-history',
        },
      },
    ]),
    card('investigate', '原调查计划', [
      {
        label: '确认调查',
        action: 'concierge_triage_confirm',
        payload: { planId: 'investigate-plan', intent: 'investigate' },
      },
      { label: '取消调查计划', action: 'concierge_triage_cancel', payload: { planId: 'investigate-plan' } },
    ]),
    card('cancel', '原取消计划', [
      {
        label: '确认第二计划',
        action: 'concierge_triage_confirm',
        payload: { planId: 'cancel-plan', intent: 'relay' },
      },
      { label: '取消第二计划', action: 'concierge_triage_cancel', payload: { planId: 'cancel-plan' } },
    ]),
  ];
  const other = [{ ...message('original-anchor', '原工作的精确记忆锚点'), threadId: OTHER_THREAD }];
  let jobStatus = 'running',
    actionState = 'ready';
  const confirmations = [];
  const calls = [];
  const preview = {
    previewId: 'opaque-preview-1',
    pageUrl: 'http://127.0.0.1:5459/',
    field: '合成备注',
    fieldSelector: '#note',
    readbackSelector: '#readback',
    operation: 'fill',
    value: '合成值',
    expectedReadback: '合成值',
    permissionScope: 'f317-synthetic',
    expiresAtMs: Date.now() + 120000,
  };
  const thread = (id) => ({
    id,
    title: id === COMPANION_THREAD ? '猫猫球 · 伴随对话' : '原工作',
    projectPath: '/fixture',
    createdBy: 'fixture-owner',
    createdAt: 1791200000000,
    lastActiveAt: 1791200000000,
    participants: [CAT.id],
    preferredCats: [CAT.id],
  });
  async function handle(route) {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      method = req.method();
    const data = req.postData() ?? '';
    calls.push({ path, method, body: data, query: url.search });
    let body = {},
      status = 200;
    if (path === '/api/cats') body = { cats: [CAT] };
    else if (path === '/api/debug/callback-auth')
      body = {
        reasonCounts: {},
        toolCounts: {},
        byCat: {},
        recentSamples: [],
        totalFailures: 0,
        startedAt: Date.now(),
        uptimeMs: 0,
        recent24h: { totalFailures: 0, byReason: {}, byTool: {}, byCat: {} },
      };
    else if (path === '/api/concierge/work/decisions')
      body = {
        version: 1,
        status: 'available',
        observedAt: Date.now(),
        sources: {
          approvals: { status: 'available', coverage: 'complete' },
          needsMe: { status: 'available', coverage: 'complete' },
        },
        items: [],
        totalCount: 0,
        page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
      };
    else if (path === '/api/config/cat-order') body = { catOrder: [CAT.id] };
    else if (path === '/api/config') body = {};
    else if (['/api/health', '/api/ready', '/health', '/ready'].includes(path)) body = { status: 'ok' };
    else if (path === '/api/session') body = { userId: 'fixture-owner', csrfToken: 'synthetic-session' };
    else if (path === '/api/concierge/config') {
      if (method === 'PUT') Object.assign(config, JSON.parse(data));
      body = { config };
    } else if (path === '/api/concierge/thread') body = { threadId: COMPANION_THREAD };
    else if (path === '/api/concierge/desktop') {
      body =
        mode === 'available'
          ? { presence: { state: 'hidden', maxAgeMs: 15000 }, desktopLost: false }
          : {
              presence: null,
              desktopLost: mode === 'failed',
              lossId: mode === 'failed' ? 'UPDATE_RESUME_FAILED' : null,
            };
    } else if (path === '/api/concierge/desktop/show')
      body = { presence: { state: 'visible', maxAgeMs: 15000 }, desktopLost: false };
    else if (path === '/api/concierge/confirmations') body = { confirmations };
    else if (path === '/api/concierge/relay') body = { receiptId: 'synthetic-relay-receipt', status: 'dispatched' };
    else if (path.endsWith('/triage/investigate-plan/confirm')) {
      confirmations.push({
        id: 'confirm-i',
        messageId: 'investigate',
        status: 'confirmed',
        action: {
          kind: 'concierge_triage_confirm',
          planId: 'investigate-plan',
          intent: 'investigate',
          investigationJobId: 'synthetic-job',
        },
      });
      body = { status: 'completed', investigationJobId: 'synthetic-job' };
    } else if (path.endsWith('/triage/cancel-plan/cancel')) {
      confirmations.push({
        id: 'confirm-c',
        messageId: 'cancel',
        status: 'cancelled',
        action: { kind: 'concierge_triage_cancel', planId: 'cancel-plan' },
      });
      body = { status: 'cancelled' };
    } else if (path.endsWith('/investigation/synthetic-job/cancel')) {
      jobStatus = 'cancelled';
      body = { status: 'cancelled' };
    } else if (path.endsWith('/investigation/synthetic-job'))
      body = {
        job: {
          status: jobStatus,
          report: jobStatus === 'done' ? { summary: '合成调查结果已回流', anchors: [] } : undefined,
        },
      };
    else if (path === '/api/concierge/page-action') {
      if (method === 'DELETE') actionState = 'ready';
      body = {
        kind: 'available',
        requestMessageId: 'owner-page-source',
        requestText: '修改合成备注',
        pageUrl: preview.pageUrl,
        state: actionState,
        ...(actionState === 'awaiting_consent' ? { preview } : {}),
        ...(actionState === 'settled'
          ? {
              result: {
                status: 'applied',
                forward: { status: 'applied', before: '', after: '合成值' },
                receiptPersistence: 'stored',
              },
            }
          : {}),
      };
    } else if (path.endsWith('/page-action/inspect')) {
      actionState = 'awaiting_consent';
      body = { status: 'awaiting_consent' };
    } else if (path.endsWith('/page-action/confirm')) {
      actionState = 'settled';
      body = { status: 'applied' };
    } else if (path === '/api/messages' && method === 'POST') {
      const multipart = req.headers()['content-type']?.includes('multipart');
      const input = multipart
        ? {
            threadId: data.match(/name="threadId"\r\n\r\n([^\r]+)/)?.[1],
            content: data.match(/name="content"\r\n\r\n([^\r]+)/)?.[1],
          }
        : JSON.parse(data);
      const stored = {
        ...message(`saved-send-${messages.length}`, input.content),
        from: { kind: 'user', userId: 'fixture-owner' },
        threadId: input.threadId,
        timestamp: Date.now(),
        contentBlocks: [
          { type: 'text', text: input.content },
          ...(multipart ? [{ type: 'image', url: '/uploads/f317-synthetic.png' }] : []),
        ],
      };
      messages.push(stored);
      body = { status: 'queued', userMessageId: stored.id };
    } else if (path === '/api/messages')
      body = {
        messages: url.searchParams.get('threadId') === OTHER_THREAD ? other : messages,
        hasMore: false,
        activeInvocations: [],
      };
    else if (path === '/api/threads') body = { threads: [thread(OTHER_THREAD), thread(COMPANION_THREAD)] };
    else if (path.endsWith('/task-progress')) body = { taskProgress: {} };
    else if (path.endsWith('/queue')) body = { queue: [], paused: false, activeInvocations: [] };
    else if (path === '/api/tasks') body = { tasks: [] };
    else if (path === '/api/bootcamp/threads') body = { threads: [] };
    else if (path === '/api/labels') body = { labels: [] };
    else if (path === '/api/config/thread-attention') body = { groups: [] };
    else if (path.endsWith('/composer-draft')) {
      const threadId = path.split('/')[3],
        current = drafts.get(threadId) ?? { draft: null, revision: 0 };
      if (method === 'PUT' || method === 'DELETE') {
        const input = JSON.parse(data);
        if (input.expectedRevision !== current.revision) {
          status = 409;
          body = { actualRevision: current.revision };
        } else {
          const revision = current.revision + 1;
          body = {
            revision,
            draft:
              method === 'DELETE'
                ? null
                : { threadId, revision, text: input.text, contentBlocks: input.contentBlocks, replyTo: input.replyTo },
          };
          drafts.set(threadId, body);
        }
      } else body = current;
    } else if (path.startsWith('/api/threads/')) body = thread(path.split('/')[3]);
    else if (path === '/api/guide-flows/synthetic-guide')
      body = {
        id: 'synthetic-guide',
        name: '原功能引导',
        description: '无媒体前端合同',
        steps: [{ id: 's1', target: 'chat.input', tips: '合成引导仍定位原输入框', advance: 'confirm' }],
      };
    else if (path.startsWith('/api/guide-actions/')) body = { status: 'ok' };
    else if (path === '/api/plugin-manager/plugins') body = { plugins: [] };
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  }
  return {
    config,
    messages,
    confirmations,
    calls,
    drafts,
    handle,
    setJobStatus: (state) => {
      jobStatus = state;
    },
  };
}
