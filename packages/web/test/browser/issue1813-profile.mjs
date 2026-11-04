import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const evidence = path.resolve(web, '../../artifacts/issue1813', process.env.PROFILE_LABEL ?? 'baseline');
const origin = 'https://issue1813.test';
await mkdir(evidence, { recursive: true });
process.chdir(web);
process.env.NODE_ENV = 'production';
const built = await build({
  root: web,
  configFile: false,
  logLevel: 'error',
  plugins: [
    {
      name: 'profile-baseline-source',
      enforce: 'pre',
      transform(_code, id) {
        const file = id.replaceAll('\\', '/').split('/packages/web/')[1];
        if (
          process.env.PROFILE_BASE_REF &&
          ['src/components/ChatMessage.tsx', 'src/components/thread-chat/useThreadChatSelection.ts'].includes(file)
        )
          return execFileSync('git', ['show', `${process.env.PROFILE_BASE_REF}:packages/web/${file}`], {
            cwd: web,
            encoding: 'utf8',
          });
      },
    },
    {
      name: 'profile-row-props',
      enforce: 'pre',
      transform(code, id) {
        if (!id.replaceAll('\\', '/').endsWith('/ChatMessageRow.tsx')) return;
        return code.replace(
          '}: ChatMessageRowProps) {',
          `}: ChatMessageRowProps) {
      const metrics = window.issue1813Metrics;
      if (metrics) {
        const props = { message, timelineMessages, activeRuns, getCatById, onEditCat, onEditCoCreator, onEnterSelection, onToggleSelection, onToggleRichBlock, capabilityTipContexts, eager, backgroundMountDelayMs };
        const previous = metrics.rowProps[message.id];
        metrics.rows.push({ id: message.id, changed: previous ? Object.keys(props).filter(key => props[key] !== previous[key]) : ['mount'] });
        metrics.rowProps[message.id] = props;
      }
    `,
        );
      },
    },
  ],
  esbuild: { jsx: 'automatic', jsxDev: false },
  resolve: {
    alias: [
      { find: 'next/navigation', replacement: path.join(web, 'test/browser/fixtures/f322-shell-navigation.ts') },
      { find: '@', replacement: path.join(web, 'src') },
    ],
  },
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin) },
  build: {
    write: false,
    minify: false,
    rollupOptions: {
      input: path.join(web, 'test/browser/fixtures/issue1813-stream.tsx'),
      output: { format: 'es', inlineDynamicImports: true },
    },
  },
});
const outputs = Array.isArray(built) ? built.flatMap((x) => x.output) : built.output;
const script = outputs.find((x) => x.type === 'chunk' && x.isEntry).code;
assert.ok(script.includes('metrics.rowProps'), 'row profiling transform must be present');
const css = outputs
  .filter((x) => x.type === 'asset' && x.fileName.endsWith('.css'))
  .map((x) => x.source)
  .join('\n');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [],
  sockets = [],
  network = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.routeWebSocket('**/socket.io/**', (socket) => {
  sockets.push(socket);
  socket.send(`0${JSON.stringify({ sid: 'isolated', upgrades: [], pingInterval: 25000, pingTimeout: 20000 })}`);
  socket.onMessage((packet) => {
    const text = String(packet);
    if (text.startsWith('40')) socket.send('40{"sid":"isolated"}');
    if (!text.startsWith('42')) return;
    const bracket = text.indexOf('['),
      ack = text.slice(2, bracket),
      [event, room] = JSON.parse(text.slice(bracket));
    if (event === 'join_room' && ack) socket.send(`43${ack}${JSON.stringify([{ ok: true, room }])}`);
  });
});
const history = Array.from({ length: 80 }, (_, i) => ({
  id: `history-${i}`,
  type: 'assistant',
  catId: 'codex',
  from: { kind: 'agent', catId: 'codex' },
  content: `History ${i}\n\n${'Ordinary persisted conversation paragraph. '.repeat(30)}`,
  timestamp: 1000 + i,
}));
await page.route('**/*', async (route) => {
  const req = route.request(),
    url = new URL(req.url());
  assert.equal(url.origin, origin, 'never access a live service');
  if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: script });
  if (url.pathname === '/proof.css') return route.fulfill({ contentType: 'text/css', body: css });
  if (url.pathname.startsWith('/api/')) {
    const start = Date.now();
    let body = {
      cats: [],
      tasks: [],
      items: [],
      threads: [],
      projects: [],
      queue: [],
      activeInvocations: [],
      executions: [],
      userId: 'isolated-owner',
    };
    if (url.pathname === '/api/messages') body = { messages: history, hasMore: false };
    if (url.pathname === '/api/cats')
      body = {
        cats: [
          {
            id: 'codex',
            displayName: 'Test cat',
            name: 'Test cat',
            color: { primary: '#987654', secondary: '#eeeeee' },
          },
        ],
      };
    if (url.pathname === '/api/threads')
      body = {
        threads: ['foreground', 'background'].map((id) => ({
          id,
          title: id,
          createdAt: 1,
          createdBy: 'isolated-owner',
          participants: [],
          projectPath: '/isolated/issue1813',
        })),
      };
    if (url.pathname === '/api/routing/preview') body = { targetCats: ['codex'], reason: 'explicit' };
    network.push({ path: url.pathname, method: req.method(), at: start });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  }
  return route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>',
  });
});
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
const target = await cdp.send('Target.getTargetInfo');
try {
  await page.goto(origin);
  await page.locator('textarea').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    const data = { longTasks: [], frames: [], inputs: [], rows: [], rowProps: {}, inputSequences: [] };
    Object.assign(window, { issue1813Metrics: data });
    new PerformanceObserver((list) =>
      data.longTasks.push(...list.getEntries().map((e) => ({ at: e.startTime, duration: e.duration }))),
    ).observe({ type: 'longtask', buffered: false });
    let last = performance.now();
    const frame = () => {
      const now = performance.now();
      data.frames.push(now - last);
      last = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    document.addEventListener('input', () => {
      const at = performance.now();
      data.inputSequences.push(window.issue1813State().seq);
      requestAnimationFrame(() => data.inputs.push(performance.now() - at));
    });
  });
  const traceComplete = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,blink.user_timing,latencyInfo',
    transferMode: 'ReturnAsStream',
  });
  await cdp.send('Profiler.start');
  const started = Date.now();
  const count = Number(process.env.PROFILE_EVENTS ?? 600);
  for (let i = 1; i <= count; i++)
    sockets[0].send(
      `42${JSON.stringify(['agent_message', { type: 'text', catId: 'codex', messageId: 'stream-response', threadId: i % 2 ? 'foreground' : 'background', seq: Math.ceil(i / 2), seqEpoch: 'epoch-a', content: `${i} ` }])}`,
    );
  const inputStart = Date.now();
  await page.locator('textarea').first().pressSequentially('typing while streaming', { delay: 15, timeout: 60000 });
  const inputMs = Date.now() - inputStart;
  assert.equal(await page.locator('textarea').first().inputValue(), 'typing while streaming');
  // A second backlog exercises navigation itself, rather than switching only
  // after the first input has waited for all queued transport callbacks.
  for (let i = count + 1; i <= count * 2; i++)
    sockets[0].send(
      `42${JSON.stringify(['agent_message', { type: 'text', catId: 'codex', messageId: 'stream-response', threadId: i % 2 ? 'foreground' : 'background', seq: Math.ceil(i / 2), seqEpoch: 'epoch-a', content: `${i} ` }])}`,
    );
  const switchStart = Date.now();
  await page.getByRole('button', { name: 'Switch thread', exact: true }).click({ timeout: 60000 });
  await page.waitForFunction(() => window.issue1813State().currentThreadId === 'background');
  const switchMs = Date.now() - switchStart;
  await page.waitForFunction(
    (n) => Object.values(window.issue1813State().seq).reduce((a, b) => a + b, 0) >= n,
    count * 2,
    {
      timeout: 60000,
    },
  );
  await page.waitForTimeout(1000);
  const { profile } = await cdp.send('Profiler.stop');
  await cdp.send('Tracing.end');
  const { stream } = await traceComplete;
  let trace = '';
  let eof = false;
  while (!eof) {
    const chunk = await cdp.send('IO.read', { handle: stream });
    trace += chunk.data;
    eof = chunk.eof;
  }
  await cdp.send('IO.close', { handle: stream });
  await writeFile(path.join(evidence, 'renderer-trace.json'), trace);
  const state = await page.evaluate(() => window.issue1813State());
  const metrics = await page.evaluate(() => {
    const { rowProps, ...metrics } = window.issue1813Metrics;
    return metrics;
  });
  for (const [thread, parity] of [
    ['foreground', 1],
    ['background', 0],
  ]) {
    const expected = Array.from({ length: count * 2 }, (_, i) => i + 1)
      .filter((i) => i % 2 === parity)
      .map((i) => `${i} `)
      .join('');
    assert.equal(
      state.messages[thread].find((m) => m.id === 'stream-response')?.content ?? '',
      expected,
      `${thread} consumes all tokens in order`,
    );
  }
  assert.deepEqual(errors, [], 'production UI has no uncaught errors');
  await page.getByRole('button', { name: 'Switch thread', exact: true }).click();
  await page.waitForFunction(() => window.issue1813State().currentThreadId === 'foreground');
  assert.equal(
    await page.locator('textarea').first().inputValue(),
    'typing while streaming',
    'returning thread retains draft',
  );
  await page.screenshot({ path: path.join(evidence, 'conversation.png') });
  const sources = {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: web, encoding: 'utf8' }).trim(),
    baselineRef: process.env.PROFILE_BASE_REF ?? null,
    bundleSha256: createHash('sha256').update(script).digest('hex'),
    foreground: await page.evaluate(() => document.visibilityState),
  };
  await writeFile(path.join(evidence, 'renderer.cpuprofile'), JSON.stringify(profile));
  await writeFile(
    path.join(evidence, 'result.json'),
    JSON.stringify(
      {
        sources,
        target,
        started,
        count,
        inputMs,
        switchMs,
        totalMs: Date.now() - started,
        metrics,
        state,
        errors,
        network,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      evidence,
      count,
      inputMs,
      switchMs,
      maxFrameMs: Math.max(...metrics.frames),
      longTasks: metrics.longTasks,
      errors,
    }),
  );
} finally {
  await browser.close();
}
