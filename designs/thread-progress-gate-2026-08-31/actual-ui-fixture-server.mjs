#!/usr/bin/env node

import http from 'node:http';

const port = Number(process.argv[2] ?? 43181);
const frontendOrigin = process.argv[3] ?? 'http://localhost:43180';
const now = Date.now();
const thread = {
  id: 'thread-f308',
  projectPath: '/acceptance/f308',
  title: 'Runtime harness 深入学习',
  createdBy: 'default-user',
  participants: ['cat-vjdun65e'],
  lastActiveAt: now,
  createdAt: now,
};
const recentProgress = [
  {
    id: 'receipt-visible-2',
    kind: 'milestone',
    headline: 'Receipt 与 ThreadBrief 已跑通',
    detail: '身份派生、幂等写入和单会话读模型均通过。',
    nextStep: '完成浏览器验收',
    actor: { kind: 'cat', catId: 'cat-vjdun65e' },
    occurredAt: now - 120_000,
  },
  {
    id: 'receipt-visible-1',
    kind: 'decision',
    headline: '确定 Phase A 不包含全局近况',
    detail: '先验证单会话闭环，避免扩大影响面。',
    actor: { kind: 'cat', catId: 'cat-vjdun65e' },
    occurredAt: now - 3_600_000,
  },
];
const brief = {
  v: 1,
  thread: { id: thread.id, title: thread.title },
  contextHeading: { label: '会话', text: thread.title },
  availability: 'ok',
  presentationState: 'needs_user',
  currentExecutions: [
    {
      catId: 'cat-vjdun65e',
      startedAt: now - 180_000,
      confidence: 'confirmed',
      action: '完成 Phase A 隔离验收',
    },
  ],
  attention: [{ kind: 'approval', label: '需要你确认最终视觉', createdAt: now - 60_000 }],
  waits: [],
  recentProgress,
  lastProgressAt: recentProgress[0].occurredAt,
  nextStep: '完成浏览器验收',
  openWorkTaskCount: 2,
  hasHistory: true,
  generatedAt: now,
};
const receipts = recentProgress.map((item, index) => ({
  ...item,
  v: 1,
  ownerUserId: 'default-user',
  threadId: thread.id,
  impactAxes: index === 0 ? ['verified_outcome', 'next_action'] : ['goal_or_scope'],
  provenance: [{ kind: 'invocation', invocationId: `inv-hidden-${index}` }],
  sourceKey: `hidden-${index}`,
  createdAt: item.occurredAt,
}));
const cats = [
  {
    id: 'cat-vjdun65e',
    displayName: '宪宪',
    color: { primary: '#8b7cf6', secondary: '#c4bdfd' },
    mentionPatterns: ['宪宪'],
    clientId: 'openai',
    defaultModel: 'gpt-5.6-sol',
    avatar: '',
    roleDescription: '主架构师',
    personality: '温柔但有主见',
  },
];
const exactResponses = new Map([
  ['/api/session', { userId: 'default-user' }],
  ['/api/cats', { cats }],
  ['/api/config/cat-order', { catOrder: ['cat-vjdun65e'] }],
  ['/api/threads', { threads: [thread] }],
  [`/api/threads/${thread.id}`, thread],
  [`/api/threads/${thread.id}/brief`, brief],
  [`/api/threads/${thread.id}/progress`, { items: receipts, nextCursor: null }],
  [`/api/threads/${thread.id}/executions/active`, { projectPath: thread.projectPath, executions: [] }],
  [`/api/threads/${thread.id}/queue`, { queue: [], activeInvocations: [] }],
  [`/api/threads/${thread.id}/task-progress`, { threadId: thread.id, taskProgress: {} }],
  [`/api/threads/${thread.id}/messages`, { messages: [], hasMore: false, nextCursor: null }],
]);

function send(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': frontendOrigin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type,x-cat-cafe-user',
  });
  response.end(JSON.stringify(body));
}

http
  .createServer((request, response) => {
    if (request.method === 'OPTIONS') return send(response, 204, {});
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const exact = exactResponses.get(path);
    if (exact) return send(response, 200, exact);
    if (path.includes('/progress/') && path.includes('/sources/')) {
      return send(response, 200, { kind: 'invocation', available: false });
    }
    if (path.startsWith('/api/')) return send(response, 200, {});
    return send(response, 404, { error: 'not found' });
  })
  .listen(port, '127.0.0.1', () => {
    process.stdout.write(`F308 actual UI fixture listening on ${port}\n`);
  });
