import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const repo = process.cwd();
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
assert.equal(commit, process.env.ISSUE1287_EXPECT_HEAD, 'Set ISSUE1287_EXPECT_HEAD to the reviewed source revision');
execFileSync('git', ['diff', '--exit-code'], { cwd: repo, stdio: 'pipe' });
execFileSync('git', ['diff', '--cached', '--exit-code'], { cwd: repo, stdio: 'pipe' });
const evidence = resolve(process.env.ISSUE1287_EVIDENCE ?? join(repo, 'artifacts', 'issue1287-browser-' + Date.now()));
await mkdir(evidence, { recursive: true });
const webRoot = join(repo, 'packages/web');
const apiRoot = join(repo, 'packages/api');
const apiRequire = createRequire(join(apiRoot, 'package.json'));
const webRequire = createRequire(join(webRoot, 'package.json'));
const load = (path) => import(pathToFileURL(join(apiRoot, path)).href);
const src = (path) => load('src/' + path + '.ts');
const inv = (path) => src('domains/cats/services/agents/invocation/' + path);
const db = (path) => src('domains/cats/services/stores/' + path);
const execPort = 12874,
  redisPort = 6398;
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = 'redis://127.0.0.1:' + redisPort + '/0';
process.env.FRONTEND_URL = 'http://127.0.0.1:' + execPort;
const origin = process.env.FRONTEND_URL;
const owner = 'issue1287-owner';
const dataDir = join(evidence, 'redis-' + process.pid);
const apiLogDir = join(evidence, 'api-' + process.pid);
process.env.LOG_DIR = join(apiLogDir, 'logs');
process.env.AUDIT_LOG_DIR = join(apiLogDir, 'audit');
await mkdir(dataDir);
const ledger = {
  issue: 1287,
  owner: 'Codex / whutzefengxie-ops',
  commit,
  repo,
  program: 'API & web package 0.1.0 source / pinned pnpm-lock.yaml',
  harnessPid: process.pid,
  apiPort: execPort,
  redisPort,
  dataDir,
  apiLogDir,
  usage: 'isolated browser with production HTTP/Socket.IO/Redis and a gated provider',
};
const saveLedger = async () => {
  const json = JSON.stringify(ledger, null, 2);
  await Promise.all(
    ['instance.json', 'instance-' + process.pid + '.json'].map((file) => writeFile(join(evidence, file), json)),
  );
};
await saveLedger();
const { chromium } = webRequire('playwright');
ledger.playwrightVersion = webRequire('playwright/package.json').version;
const { build } = await import(
  pathToFileURL(webRequire.resolve('vite/package.json').replace(/package\.json$/, 'dist/node/index.js')).href
);
const fixture = await readFile(new URL('./fixtures/issue1287-browser-host.tsx', import.meta.url), 'utf8');
const { createHash } = await import('node:crypto');
const bundleKey = createHash('sha256').update(ledger.commit).update(origin).update(fixture).digest('hex').slice(0, 12);
const bundleJs = join(evidence, 'bundle-' + bundleKey + '.js');
const bundleCss = join(evidence, 'bundle-' + bundleKey + '.css');
const entry = join(webRoot, 'test/browser/fixtures/issue1287-proof.tsx').replaceAll('\\', '/');
const cwd = process.cwd();
process.chdir(webRoot);
let built, js, css;
try {
  [js, css] = await Promise.all([readFile(bundleJs, 'utf8'), readFile(bundleCss, 'utf8')]);
} catch {}
try {
  if (!js || !css)
    built = await build({
      root: webRoot,
      configFile: false,
      logLevel: 'error',
      esbuild: { jsx: 'automatic' },
      plugins: [
        {
          name: 'issue1287-browser-host',
          resolveId(id) {
            if (id === entry) return entry;
          },
          load(id) {
            if (id === entry) return fixture;
          },
        },
      ],
      resolve: {
        alias: [
          { find: 'next/navigation', replacement: join(webRoot, 'test/browser/fixtures/f322-shell-navigation.ts') },
          { find: '@', replacement: join(webRoot, 'src') },
        ],
      },
      define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin) },
      build: {
        write: false,
        minify: false,
        rollupOptions: { input: entry, output: { format: 'es', inlineDynamicImports: true } },
      },
    });
} finally {
  process.chdir(cwd);
}
if (built) {
  js = built.output.find((x) => x.isEntry).code;
  css = built.output
    .filter((x) => x.fileName.endsWith('.css'))
    .map((x) => x.source)
    .join('\n');
  await Promise.all([writeFile(bundleJs, js), writeFile(bundleCss, css)]);
}
console.log('browser built', js.length, css.length);
ledger.bundleSha256 = createHash('sha256').update(js).digest('hex');
const templateDir = join(apiLogDir, 'fixture-template');
await mkdir(templateDir, { recursive: true });
process.env.CAT_TEMPLATE_PATH = join(templateDir, 'cat-template.json');
await copyFile(join(repo, 'cat-template.json'), process.env.CAT_TEMPLATE_PATH);
const { catRegistry } = await import(pathToFileURL(join(repo, 'packages/shared/dist/index.js')).href);
const { loadResolvedCatConfig, toAllCatConfigs } = await src('config/cat-config-loader');
for (const [id, config] of Object.entries(toAllCatConfigs(loadResolvedCatConfig(process.env.CAT_TEMPLATE_PATH)))) {
  if (!catRegistry.has(id)) catRegistry.register(id, config);
}
const [
  { InvocationQueue },
  { InvocationRegistry },
  { InvocationTracker },
  { QueueProcessor },
  { routeSerial },
  { SessionManager },
  { RedisTurnExecutionStore },
  { RedisInvocationRecordStore },
  { RedisMessageStore },
  { RedisQueueLedgerStore },
  { messagesRoutes },
  { queueRoutes },
  { SocketManager },
  { sessionAuthPlugin, sessionRoute },
] = await Promise.all([
  inv('InvocationQueue'),
  inv('InvocationRegistry'),
  inv('InvocationTracker'),
  inv('QueueProcessor'),
  src('domains/cats/services/agents/routing/route-serial'),
  src('domains/cats/services/session/SessionManager'),
  db('redis/RedisTurnExecutionStore'),
  db('redis/RedisInvocationRecordStore'),
  db('redis/RedisMessageStore'),
  inv('queue-ledger/RedisQueueLedgerStore'),
  src('routes/messages'),
  src('routes/queue'),
  src('infrastructure/websocket/SocketManager'),
  src('infrastructure/session-auth'),
]);
const Fastify = apiRequire('fastify');
const Redis = apiRequire('ioredis');
const redisBinary = process.env.ISSUE1287_REDIS_SERVER ?? 'redis-server';
ledger.redisBinary = redisBinary;
const app = Fastify();
const redis = new Redis({
  host: '127.0.0.1',
  port: redisPort,
  keyPrefix: 'issue1287:',
  lazyConnect: true,
  retryStrategy: () => null,
});
let redisProcess, socketManager, browser, browserServer, runFailure;
const evidenceRows = [];
const gated = new Map();
const threads = new Map();
const sentEvents = [];
const httpReads = [];
const resultsPath = join(evidence, 'results.json');
const flush = () => writeFile(resultsPath, JSON.stringify(evidenceRows, null, 2));
function gate() {
  let open;
  const promise = new Promise((r) => {
    open = r;
  });
  return { open, promise };
}
async function waitFor(read, why, ms = 7000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const result = await read();
    if (result) return result;
    await delay(30);
  }
  throw Error('Timed out: ' + why);
}
function thread(id) {
  return { id, createdBy: owner, title: id, projectPath: evidence, createdAt: 1, lastActiveAt: 1, participants: [] };
}
try {
  // This preflight runs again immediately before creating any test listener.
  const { connect } = await import('node:net');
  for (const port of [execPort, redisPort]) {
    const open = await new Promise((resolve) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    assert.equal(open, false, 'reserved test port already in use: ' + port);
  }
  redisProcess = spawn(
    redisBinary,
    [
      '--bind',
      '127.0.0.1',
      '--port',
      String(redisPort),
      '--dir',
      dataDir,
      '--dbfilename',
      'issue1287.rdb',
      '--appendonly',
      'yes',
      '--appendfsync',
      'always',
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  ledger.redisPid = redisProcess.pid;
  await saveLedger();
  await Promise.race([
    new Promise((resolve, reject) => {
      redisProcess.stdout.on('data', (data) => {
        process.stdout.write(data);
        if (/ready to accept connections/i.test(String(data))) resolve();
      });
      redisProcess.stderr.on('data', (data) => process.stderr.write(data));
      redisProcess.once('error', reject);
      redisProcess.once('exit', (code) => reject(Error('Redis exited: ' + code)));
    }),
    delay(8000).then(() => {
      throw Error('Redis startup timeout');
    }),
  ]);
  await redis.connect();
  assert.equal(await redis.ping(), 'PONG');
  const contractLog = execFileSync(
    process.execPath,
    ['--test', 'packages/api/test/messages-watermark-contract.test.js'],
    {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, REDIS_URL: 'redis://127.0.0.1:' + redisPort + '/15', CAT_CAFE_REDIS_TEST_ISOLATED: '1' },
    },
  );
  await writeFile(join(evidence, 'redis-contract.log'), contractLog);
  ledger.redisContractResult = 'PASS';
  const messages = new RedisMessageStore(redis);
  const turns = new RedisTurnExecutionStore(redis);
  const records = new RedisInvocationRecordStore(redis);
  const registry = new InvocationRegistry({ turnExecutionStore: turns });
  const tracker = new InvocationTracker();
  let processor;
  const queue = new InvocationQueue(new RedisQueueLedgerStore(redis), {
    onAdmitted: ({ threadId }) => void processor.requestDrain(threadId),
  });
  const threadStore = {
    get: async (id) => threads.get(id),
    getParticipantsWithActivity: async () => [],
    addParticipants: async () => {},
    updateParticipantActivity: async () => {},
    consumeMentionRoutingFeedback: async () => null,
  };
  const router = {
    previewTargets: async () => ({ targetCats: [], reason: { kind: 'default_cat' } }),
    resolveExplicitTargets: async (targets) => [...targets],
    resolveTargetsAndIntent: async () => ({
      targetCats: ['opus'],
      intent: { intent: 'execute', explicit: true },
      hasMentions: true,
    }),
    resolveConversationTargetsAtAdmission: async (targets) => [...targets],
    async *routeExecution(userId, content, threadId, _messageId, targets, _intent, options) {
      const g = gated.get(threadId);
      const service = {
        async *invoke() {
          g.entered.open();
          await g.start.promise;
          yield { type: 'text', catId: 'opus', content: 'Reply ' + threadId + ' partial. ', timestamp: Date.now() };
          g.partial.open();
          await g.finish.promise;
          const tool = {
            catId: 'opus',
            toolName: 'Read',
            toolSource: 'host_cli',
            toolUseId: 'read-1',
            timestamp: Date.now(),
          };
          yield { ...tool, type: 'tool_use', toolInput: { path: 'proof.txt' } };
          yield { ...tool, type: 'tool_result', content: 'read succeeded' };
          yield {
            type: 'system_info',
            catId: 'opus',
            timestamp: Date.now(),
            content: JSON.stringify({
              type: 'rich_block',
              block: {
                kind: 'card',
                v: 1,
                id: 'card-' + threadId,
                title: 'Evidence card ' + threadId,
                bodyMarkdown: 'Durable fixture card',
              },
            }),
          };
          yield { type: 'text', catId: 'opus', content: 'Complete ' + threadId + '.', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      };
      yield* routeSerial(
        {
          services: { opus: service },
          messageStore: messages,
          invocationDeps: {
            registry,
            turnExecutionStore: turns,
            sessionManager: new SessionManager(),
            apiUrl: origin,
            threadStore,
          },
        },
        targets,
        content,
        userId,
        threadId,
        options,
      );
    },
    ackCollectedCursors: async () => {},
  };
  socketManager = new SocketManager(app.server, tracker);
  for (const method of ['broadcastAgentMessage', 'emitToUser', 'broadcastToRoom']) {
    const original = socketManager[method].bind(socketManager);
    socketManager[method] = (...args) => {
      const [a, b, c] = args;
      sentEvents.push(
        method === 'broadcastAgentMessage'
          ? { event: 'agent_message', threadId: b, data: a }
          : { event: b, threadId: c?.threadId, data: c, recipient: a },
      );
      return original(...args);
    };
  }
  processor = new QueueProcessor({
    queue,
    messageStore: messages,
    invocationTracker: tracker,
    turnExecutionStore: turns,
    invocationRecordStore: records,
    router,
    socketManager,
    log: {
      debug() {},
      info() {},
      warn(...args) {
        console.warn(...args);
      },
      error(...args) {
        console.error(...args);
      },
    },
  });
  const routeOptions = {
    registry,
    messageStore: messages,
    invocationQueue: queue,
    queueProcessor: processor,
    invocationTracker: tracker,
    invocationRecordStore: records,
    turnExecutionStore: turns,
    router,
    socketManager,
    threadStore,
  };
  await app.register(apiRequire('@fastify/cookie'));
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: owner });
  // HTTP log records only browser requests, excluding evidence readback via Fastify inject.
  app.addHook('onRequest', async (request) => {
    if (request.method === 'GET' && request.url.startsWith('/api/') && request.headers['sec-fetch-mode']) {
      httpReads.push({ at: Date.now(), url: request.url });
    }
  });
  await app.register(messagesRoutes, routeOptions);
  await app.register(queueRoutes, routeOptions);
  app.get('/proof.js', (_r, reply) => reply.type('text/javascript').send(js));
  app.get('/proof.css', (_r, reply) => reply.type('text/css').send(css));
  app.get('/', (_r, reply) =>
    reply
      .type('text/html')
      .send(
        '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>',
      ),
  );
  app.get('/api/*', async () => ({
    threads: [],
    tasks: [],
    cats: [],
    activeInvocations: [],
    executions: [],
    queue: [],
  }));
  app.post('/api/*', async () => ({ ok: true }));
  await app.listen({ host: '127.0.0.1', port: execPort });
  ledger.apiPid = process.pid;
  ledger.redisVersion = (await redis.info('server')).match(/redis_version:([^\r\n]+)/)?.[1];
  ledger.redisBinarySha256 = createHash('sha256')
    .update(await readFile(redisBinary))
    .digest('hex');
  browserServer = await chromium.launchServer({ headless: true, host: '127.0.0.1' });
  ledger.browserPid = browserServer.process().pid;
  browser = await chromium.connect(browserServer.wsEndpoint());
  ledger.browserVersion = browser.version();
  await saveLedger();
  const inject = async (url) => {
    const res = await app.inject({ method: 'GET', url, headers: { 'x-cat-cafe-user': owner } });
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };
  const findMessage = (id, tid) =>
    inject('/api/messages?threadId=' + tid + '&limit=50').then((result) => result.messages.find((m) => m.id === id));
  const readState = (page, tid) => page.evaluate((id) => window.proofState(id), tid);
  const screenshot = (page, name) =>
    page.screenshot({
      path: join(evidence, name + '.png'),
      timeout: 4500,
      clip: { x: 0, y: 0, width: 1160, height: 460 },
    });
  const run = async (name, test) => {
    const id = name,
      other = name + '-other';
    const rows = { name, events: [], checkpoints: [], pageErrors: [] };
    evidenceRows.push(rows);
    const firstRead = httpReads.length,
      firstEvent = sentEvents.length;
    const g = { entered: gate(), start: gate(), partial: gate(), finish: gate() };
    gated.set(id, g);
    for (const tid of [id, other]) {
      threads.set(tid, thread(tid));
      await messages.append({
        threadId: tid,
        userId: owner,
        from: { kind: 'user', userId: owner },
        content: 'Seed ' + tid,
        mentions: [],
        timestamp: Date.now(),
      });
    }
    const context = await browser.newContext({ viewport: { width: 1160, height: 840 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', (e) => {
      rows.pageErrors.push(String(e));
      console.error('page error', name, String(e));
    });
    let mode = 'none',
      proxy,
      upstream,
      terminalFrame;
    await context.route('**/*', (route) => {
      if (new URL(route.request().url()).origin !== origin) return route.abort();
      if (route.request().url().includes('/socket.io/') && mode === 'offline') return route.abort();
      return route.continue();
    });
    await page.routeWebSocket('**/socket.io/**', (ws) => {
      if (mode === 'offline') {
        void ws.close({ code: 1011, reason: 'test transport blocked' });
        return;
      }
      proxy = ws;
      upstream = ws.connectToServer();
      upstream.onMessage((frame) => {
        const payload = String(frame);
        if (payload.startsWith('42')) {
          const [event, data] = JSON.parse(payload.slice(2));
          const block = mode === 'all' || (mode === 'stream' && event === 'agent_message');
          rows.events.push({
            event,
            threadId: data?.threadId,
            type: data?.type,
            seq: data?.seq,
            id: data?.message?.id ?? data?.messageId,
            status: data?.message?.lifecycle?.status,
            invocationId: data?.message?.lifecycle?.invocationId ?? data?.invocationId,
            dropped: block,
          });
          if (block) return;
          if (event === 'message_lifecycle_updated' && data?.message?.lifecycle?.status === 'completed')
            terminalFrame = frame;
        }
        if (payload.startsWith('43')) {
          const bracket = payload.indexOf('[');
          if (bracket >= 0) {
            const [ack] = JSON.parse(payload.slice(bracket));
            rows.events.push({ event: 'join_ack', ...ack });
          }
        }
        ws.send(frame);
      });
    });
    const open = () => page.goto(origin + '/?target=' + id);
    const joined = (tid = id) =>
      waitFor(
        () => [...(socketManager.getIO().sockets.adapter.rooms.get('thread:' + tid) ?? [])].length > 0,
        'join ' + tid,
      );
    const unjoined = (tid = id) =>
      waitFor(() => !socketManager.getIO().sockets.adapter.rooms.has('thread:' + tid), 'leave ' + tid);
    const waitActive = () => waitFor(async () => (await readState(page, id)).active, 'observed active invocation');
    const connected = () => page.locator('main[data-connected="true"]').waitFor({ timeout: 8000 });
    const switchTo = async (tid) => {
      await page.getByRole('button', { name: tid === id ? 'Target' : 'Other', exact: true }).click();
      await page.locator('main[data-thread="' + tid + '"]').waitFor();
    };
    const offline = async (foregroundThreadId = id) => {
      mode = 'offline';
      const io = socketManager.getIO();
      const peers = [...(io.sockets.adapter.rooms.get('thread:' + foregroundThreadId) ?? [])];
      assert.equal(peers.length, 1);
      io.sockets.sockets.get(peers[0]).conn.close(true);
      await page.locator('main[data-connected="false"]').waitFor({ timeout: 8000 });
      await waitFor(
        () => !socketManager.getIO().sockets.adapter.rooms.has('thread:' + foregroundThreadId),
        'socket leaves room',
      );
    };
    const saveTerminal = async () => {
      g.start.open();
      g.finish.open();
      const durable = await waitFor(async () => {
        const result = await findMessage(rows.responseId, id);
        return result?.lifecycle?.status === 'completed' ? result : null;
      }, 'durable completed');
      await waitFor(
        () =>
          sentEvents
            .slice(firstEvent)
            .find(
              (e) =>
                e.event === 'message_lifecycle_updated' &&
                e.data?.message?.id === rows.responseId &&
                e.data?.message?.lifecycle?.status === 'completed',
            ),
        'server terminal wire event',
      );
      const stored = await messages.getById(durable.id);
      assert.equal(stored.content, durable.content);
      assert.deepEqual(stored.toolEvents, durable.toolEvents);
      assert.equal(durable.lifecycle.invocationId, rows.invocationId);
      assert.equal(durable.toolEvents.length, 2);
      assert.equal(durable.replyTo, rows.inputId);
      assert.equal(durable.extra?.rich?.blocks?.[0]?.id, 'card-' + id);
      rows.durable = durable;
      rows.turn = await waitFor(async () => {
        const turn = await turns.get(rows.invocationId);
        return turn?.responseSettlement?.messageId === durable.id ? turn : null;
      }, 'child terminal record points to the durable reply');
      rows.record = await waitFor(async () => {
        const record = await records.get(rows.turn.parentInvocationId);
        return record?.status === 'succeeded' ? record : null;
      }, 'parent terminal record');
      rows.source = await messages.getById(rows.inputId);
      rows.queueAtEnd = await inject('/api/threads/' + id + '/queue');
      assert.equal(rows.source.lifecycle.dispatchRefs[0].statusMessageId, durable.id);
      const event = sentEvents
        .slice(firstEvent)
        .find(
          (e) =>
            e.event === 'message_lifecycle_updated' &&
            e.data?.message?.id === durable.id &&
            e.data?.message?.lifecycle?.status === 'completed',
        );
      for (const field of ['content', 'toolEvents', 'replyTo'])
        assert.deepEqual(event.data.message[field], durable[field]);
      assert.deepEqual(event.data.message.extra?.rich, durable.extra?.rich);
      return durable;
    };
    const snapshot = async (label) => {
      const state = await readState(page, id);
      const rendered = await page.locator('[data-message-id="' + rows.responseId + '"]').count();
      const visibleFinal = await page.getByText('Complete ' + id + '.', { exact: false }).count();
      const checkpoint = {
        label,
        documentVisibility: await page.evaluate(() => document.visibilityState),
        activePane: await page.evaluate(() => document.querySelector('main')?.dataset.thread ?? null),
        rendered,
        visibleFinal,
        at: Date.now(),
        local: {
          ...state,
          messages: state.messages.map((m) => ({
            id: m.id,
            type: m.type,
            content: m.content,
            lifecycle: m.lifecycle,
            toolEvents: m.toolEvents,
            replyTo: m.replyTo,
            rich: m.extra?.rich,
            isStreaming: m.isStreaming,
            origin: m.origin,
          })),
        },
        historyReads: httpReads
          .slice(firstRead)
          .filter((x) => x.url.startsWith('/api/messages'))
          .map((x) => x.url),
        watermarkReads: httpReads
          .slice(firstRead)
          .filter((x) => x.url.includes('/watermark'))
          .map((x) => x.url),
      };
      rows.checkpoints.push(checkpoint);
      return checkpoint;
    };
    const expectFinal = async (label) => {
      await page
        .getByText('Complete ' + id + '.', { exact: false })
        .first()
        .waitFor({ timeout: 8000 });
      const s = await snapshot(label);
      assert.equal(s.rendered, 1);
      assert.equal(s.visibleFinal, 1);
      const actual = s.local.messages.find((m) => m.id === rows.responseId);
      assert.equal(actual.content, rows.durable.content);
      assert.deepEqual(actual.toolEvents, rows.durable.toolEvents);
      assert.deepEqual(actual.replyTo, rows.durable.replyTo);
      assert.deepEqual(actual.rich, rows.durable.extra?.rich);
      assert.equal(s.local.messages.filter((m) => m.content?.includes('Reply ' + id + ' partial.')).length, 1);
      assert.equal(actual.isStreaming ?? false, false);
      return s;
    };
    try {
      await open();
      await connected();
      await joined();
      await page.getByText('Seed ' + id, { exact: true }).waitFor({ timeout: 7000 });
      await test({
        id,
        other,
        rows,
        page,
        context,
        connected,
        joined,
        unjoined,
        waitActive,
        switchTo,
        offline,
        g,
        saveTerminal,
        snapshot,
        expectFinal,
        laterSeq: () =>
          socketManager.broadcastAgentMessage(
            { type: 'status', catId: 'opus', content: 'next seq witness', timestamp: Date.now() },
            id,
          ),
        mode: (value) => {
          mode = value;
        },
        replay: () => {
          assert(terminalFrame);
          proxy.send(terminalFrame);
        },
        submit: async () => {
          const sent = await page.evaluate((id) => window.proofSend(id, '@opus run ' + id), id);
          assert.equal(sent.status, 202, JSON.stringify(sent));
          rows.inputId = sent.payload.userMessageId;
          await Promise.race([
            g.entered.promise,
            delay(8000).then(() => {
              throw Error('provider did not start');
            }),
          ]);
          const input = await messages.getById(rows.inputId);
          rows.responseId = input.lifecycle.dispatchRefs[0].statusMessageId;
          rows.processing = await messages.getById(rows.responseId);
          rows.invocationId = rows.processing.lifecycle.invocationId;
          assert.equal(rows.processing.lifecycle.status, 'processing');
        },
        shot: (label) => screenshot(page, name + '-' + label),
      });
      assert.deepEqual(rows.pageErrors, []);
    } catch (error) {
      rows.harnessError = String(error?.stack ?? error);
      console.error(name, rows.harnessError);
      await snapshot('harness-error').catch(() => {});
      await screenshot(page, name + '-harness-error').catch(() => {});
      runFailure = true;
    } finally {
      g.start.open();
      g.finish.open();
      rows.serverEvents = sentEvents.slice(firstEvent);
      rows.http = httpReads.slice(firstRead);
      await context.close();
      await flush();
    }
    console.log(
      JSON.stringify({
        name,
        responseId: rows.responseId,
        result: rows.result,
        checkpoints: rows.checkpoints.map((x) => [x.label, x.visibleFinal, x.historyReads.length]),
        harnessError: rows.harnessError,
      }),
    );
  };

  const selected = process.env.ISSUE1287_CASE;
  const scenario = (name, test) => (!selected || selected.split(',').includes(name) ? run(name, test) : undefined);
  await scenario('live', async (p) => {
    await p.submit();
    p.g.start.open();
    await p.page.getByText('Reply live partial.', { exact: false }).first().waitFor({ timeout: 8000 });
    const partial = await p.snapshot('partial visible before terminal');
    assert.equal(partial.rendered, 1);
    assert.equal(partial.visibleFinal, 0);
    await p.saveTerminal();
    await p.expectFinal('normal final');
    p.replay();
    p.replay();
    await delay(250);
    await p.expectFinal('same terminal frame replayed twice');
    await p.shot('final');
    p.rows.result = 'PASS';
  });
  await scenario('stream-lost', async (p) => {
    p.mode('stream');
    await p.submit();
    await p.saveTerminal();
    await p.expectFinal('committed upsert without stream');
    assert(p.rows.events.some((e) => e.event === 'agent_message' && e.type === 'done' && e.dropped));
    assert(
      p.rows.events.some((e) => e.event === 'message_lifecycle_updated' && e.status === 'completed' && !e.dropped),
    );
    p.rows.result = 'PASS';
  });
  await scenario('disconnect', async (p) => {
    await p.submit();
    p.g.start.open();
    await p.page.getByText('Reply disconnect partial.', { exact: false }).first().waitFor({ timeout: 8000 });
    await p.offline();
    await p.saveTerminal();
    assert.equal((await p.snapshot('persisted while disconnected')).visibleFinal, 0);
    p.mode('none');
    await p.connected();
    await p.joined();
    await p.expectFinal('auto reconnect, no reload');
    p.rows.result = 'PASS';
  });
  await scenario('disconnect-background', async (p) => {
    await p.submit();
    await p.waitActive();
    await p.switchTo(p.other);
    await p.joined(p.other);
    // PR-3b on next: live background work also leaves the foreground room.
    await p.unjoined();
    await p.offline(p.other);
    await p.saveTerminal();
    assert.equal((await p.snapshot('background response persisted offline')).visibleFinal, 0);
    p.mode('none');
    await p.connected();
    await p.joined(p.other);
    await p.unjoined();
    await waitFor(
      async () => (await readState(p.page, p.id)).requested > 0,
      'background catch-up requested after reconnect',
    );
    const bg = await p.snapshot('reconnect marks background catch-up');
    assert(bg.local.requested > 0);
    assert.equal(bg.visibleFinal, 0);
    await p.switchTo(p.id);
    await p.expectFinal('pending background catch-up consumed on return');
    p.rows.result = 'PASS';
  });
  await scenario('sequence-gap', async (p) => {
    await p.submit();
    p.g.start.open();
    await p.page.getByText('Reply sequence-gap partial.', { exact: false }).first().waitFor({ timeout: 8000 });
    await p.snapshot('first stream visible');
    p.mode('all');
    await p.saveTerminal();
    await delay(350);
    assert.equal((await p.snapshot('tail lost, prior sequence retained')).visibleFinal, 0);
    p.mode('none');
    p.laterSeq();
    const after = await p.expectFinal('later sequence gap triggers bounded history read');
    assert(after.local.consumed > 0);
    assert(after.historyReads.length > 1);
    p.rows.result = 'PASS';
  });
  await scenario('rejoin-before-commit', async (p) => {
    await p.submit();
    await p.offline();
    p.mode('none');
    await p.connected();
    await p.joined();
    assert.equal((await p.snapshot('rejoined before release')).visibleFinal, 0);
    await p.saveTerminal();
    await p.expectFinal('live terminal after rejoin');
    p.rows.result = 'PASS';
  });
  await scenario('f5-after-commit', async (p) => {
    p.mode('all');
    await p.submit();
    await p.saveTerminal();
    assert.equal((await p.snapshot('stale before F5')).visibleFinal, 0);
    await p.page.reload({ waitUntil: 'domcontentloaded' });
    await p.connected();
    await p.joined();
    await p.expectFinal('cold history after F5');
    p.rows.result = 'PASS';
  });
  await scenario('f5-before-commit', async (p) => {
    await p.submit();
    await p.page.reload({ waitUntil: 'domcontentloaded' });
    await p.connected();
    await p.joined();
    assert.equal((await p.snapshot('F5 rejoined while running')).visibleFinal, 0);
    await p.saveTerminal();
    await p.expectFinal('terminal after reload rejoin');
    p.rows.result = 'PASS';
  });
  await scenario('visibility', async (p) => {
    p.mode('all');
    await p.page.evaluate(() =>
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }),
    );
    await p.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await p.submit();
    await p.saveTerminal();
    assert.equal((await p.snapshot('hidden: committed but absent')).visibleFinal, 0);
    await p.page.evaluate(() => {
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await p.expectFinal('visible on same connected socket');
    p.rows.result = 'PASS';
  });
  await scenario('background-active-quiet', async (p) => {
    await p.submit();
    await p.waitActive();
    await p.switchTo(p.other);
    await p.joined(p.other);
    await p.unjoined();
    p.mode('all');
    await p.saveTerminal();
    await p.unjoined();
    assert.equal((await p.snapshot('background work left target room; no terminal packets received')).visibleFinal, 0);
    await p.switchTo(p.id);
    await p.expectFinal('active local state revalidates when revisited');
    p.rows.result = 'PASS';
  });
  await scenario('background-quiet', async (p) => {
    await p.switchTo(p.other);
    await p.joined(p.other);
    await p.unjoined();
    await p.page.getByText('Seed ' + p.other, { exact: true }).waitFor({ timeout: 7000 });
    p.mode('all');
    await p.submit();
    await p.saveTerminal();
    const before = await p.snapshot('other pane active, idle target room pruned');
    await p.shot('while-in-b');
    assert.equal(before.local.active, false);
    assert.equal(before.local.unread, 0);
    await p.switchTo(p.id);
    await delay(2400);
    const after = await p.snapshot('target revisited while browser stayed visible');
    p.rows.result = after.visibleFinal === 1 ? 'PASS' : 'FAIL';
    await p.shot('return');
    if (after.visibleFinal === 0) {
      await p.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await p.expectFinal('visibility trigger as diagnostic');
      await p.shot('recovered');
    }
  });
  await scenario('foreground-quiet', async (p) => {
    p.mode('all');
    await p.submit();
    await p.saveTerminal();
    const before = await p.snapshot('completed with all data events lost');
    assert.equal(before.local.active, false);
    await delay(32000);
    const after = await p.snapshot('still visible after 32 s and watchdog');
    await p.shot('after-32s');
    p.rows.result = after.visibleFinal === 1 ? 'PASS' : 'FAIL';
    if (after.visibleFinal === 0) {
      await p.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await p.expectFinal('visibility trigger as diagnostic');
    }
  });
  // AOF uses appendfsync always. SHUTDOWN SAVE below produces the retained RDB.
} finally {
  if (browser) await Promise.race([browser.close(), delay(1500)]);
  if (browserServer?.process().exitCode === null && browserServer.process().signalCode === null)
    await browserServer.kill();
  console.log('test browser close requested');
  socketManager?.getIO().disconnectSockets(true);
  const appClosing = app.close();
  app.server.closeAllConnections();
  await Promise.race([appClosing, delay(3000)]);
  socketManager?.close();
  if (redisProcess?.exitCode === null && redis.status === 'ready') {
    const exit = once(redisProcess, 'exit');
    spawn(
      process.env.ISSUE1287_REDIS_CLI ?? redisBinary.replace(/redis-server(\.exe)?$/, 'redis-cli$1'),
      ['-h', '127.0.0.1', '-p', String(redisPort), 'SHUTDOWN', 'SAVE'],
      { windowsHide: true, stdio: 'ignore' },
    );
    await Promise.race([exit, delay(6000)]);
  }
  ledger.redisExitCode = redisProcess?.exitCode;
  ledger.apiListening = app.server.listening;
  ledger.browserExitCode = browserServer?.process().exitCode;
  ledger.browserExitSignal = browserServer?.process().signalCode;
  ledger.dataDisposition = 'retain isolated Redis RDB/AOF and evidence';
  await saveLedger();
  redis.disconnect();
}
if (runFailure || evidenceRows.some((row) => row.result !== 'PASS')) process.exitCode = 1;
