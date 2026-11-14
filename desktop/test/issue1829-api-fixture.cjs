const http = require('node:http');
const { createRequire } = require('node:module');
const path = require('node:path');
const { Server } = createRequire(path.resolve(__dirname, '../../packages/api/package.json'))('socket.io');

// Deliberately synthetic history and a schema-valid member (including carrier).
const cats = [
  {
    id: 'codex',
    displayName: 'Desktop test cat',
    name: 'Desktop test cat',
    avatar: '/avatars/codex.png',
    color: { primary: '#987654', secondary: '#eeeeee' },
    carrier: 'app_server',
    clientId: 'openai',
    mentionPatterns: ['@codex'],
    defaultModel: 'test',
  },
  {
    id: 'opus',
    displayName: 'Desktop second cat',
    name: 'Desktop second cat',
    avatar: '/avatars/opus.png',
    color: { primary: '#765498', secondary: '#eeeeee' },
    carrier: 'cli',
    clientId: 'anthropic',
    mentionPatterns: ['@opus'],
    defaultModel: 'test',
  },
];
const threads = ['probe-a', 'probe-b'].map((id) => ({
  id,
  title: id,
  participants: ['codex', 'opus'],
  createdBy: 'probe-owner',
  createdAt: 1,
  lastActiveAt: 2,
  projectPath: '/isolated/probe',
}));

async function startApiFixture() {
  const reads = [];
  const responses = {
    '/api/projects/cwd': { path: '/isolated/probe' },
    '/api/agent-hooks/status': { status: 'configured', targets: [] },
    '/api/config': { cats, coCreator: { name: 'Test owner', aliases: [], mentionPatterns: [] } },
    '/api/config/conversation-view': { stored: null, effective: { mode: 'group' }, source: 'product' },
    '/api/routing/preview': { targetCats: ['codex'], reason: { kind: 'default_cat' } },
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    response.setHeader('access-control-allow-origin', request.headers.origin || '*');
    response.setHeader('access-control-allow-credentials', 'true');
    response.setHeader('access-control-allow-headers', request.headers['access-control-request-headers'] || '*');
    response.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (request.method === 'OPTIONS') return response.writeHead(204).end();
    reads.push({ path: url.pathname + url.search, method: request.method, at: Date.now() });
    let body = responses[url.pathname] || {
      cats,
      threads,
      rows: threads,
      tasks: [],
      items: [],
      projects: [],
      queue: [],
      activeInvocations: [],
      executions: [],
      userId: 'probe-owner',
      csrfToken: 'probe-token',
      catOrder: ['codex', 'opus'],
      data: [],
      failures: [],
      total: 0,
      groups: [],
      connections: [],
      recent24h: { byCat: {}, byReason: {}, byTool: {} },
    };
    if (url.pathname === '/api/messages')
      body = {
        messages: Array.from({ length: 80 }, (_, i) => ({
          id: `${url.searchParams.get('threadId')}-m${i}`,
          type: 'assistant',
          from: { kind: 'agent', catId: 'codex' },
          catId: 'codex',
          content: `${url.searchParams.get('threadId')} history ${i}. ${'Sample text. '.repeat(20)}`,
          timestamp: 1000 + i,
        })),
        hasMore: false,
      };
    if (url.pathname === '/api/artifacts' || /\/artifacts$/.test(url.pathname))
      body = {
        artifacts: [],
        workLineage: 'resolved',
        complete: true,
        total: 0,
        view: 'works',
      };
    if (/^\/api\/threads\/[^/]+$/.test(url.pathname)) body = threads.find((t) => url.pathname.endsWith(t.id));
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  });
  const io = new Server(server, { cors: { origin: true, credentials: true } });
  io.on('connection', (socket) => {
    socket.on('join_room', (room, ack) => {
      socket.join(room);
      ack?.({ ok: true, room });
    });
    socket.on('leave_room', (room) => socket.leave(room));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, io, reads, port: server.address().port };
}
module.exports = { startApiFixture };
