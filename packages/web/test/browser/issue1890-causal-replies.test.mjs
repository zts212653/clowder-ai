import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';

// Real chat surface, history hydration, actions and CSS; isolated wire data only.
test('issue1890 causal reading remains consistent live, complete and after refresh', { timeout: 240000 }, async () => {
  const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const origin = 'https://issue1890.test';
  const before = '我先核对原来的调用链。\n\n';
  const tail = '收到鲸鲸审查，已修正并准备好 PR。';
  const boundary = {
    inputMessageId: 'S',
    contentOffset: before.length,
    prefixSha256: createHash('sha256').update(before).digest('hex'),
  };
  const response = (content, status = 'processing', adopted = true) => ({
    id: 'R',
    type: 'assistant',
    from: { kind: 'agent', catId: 'codex' },
    catId: 'codex',
    origin: 'stream',
    timestamp: 1000,
    content,
    isStreaming: status === 'processing',
    lifecycle: {
      kind: 'response',
      orderKey: '1000:turn',
      invocationId: 'turn',
      targetId: 'codex',
      inputEntryIds: adopted ? ['first', 'review'] : ['first'],
      inputMessageIds: adopted ? ['U', 'S'] : ['U'],
      status,
      startedAt: 1000,
      ...(status === 'processing' ? {} : { completedAt: 4000 }),
      ...(adopted ? { appendBoundaries: [boundary] } : {}),
    },
    extra: { stream: { invocationId: 'parent', turnInvocationId: 'turn' } },
  });
  const input = {
    id: 'S',
    type: 'assistant',
    from: { kind: 'agent', catId: 'dsh' },
    catId: 'dsh',
    timestamp: 2000,
    content: '审查通过，请修正后转 Ready。',
    lifecycle: {
      kind: 'input',
      orderKey: '2000:S',
      dispatchRefs: [{ targetId: 'codex', statusMessageId: 'R', phase: 'dispatched', dispatchedAt: 2500 }],
    },
  };
  let history = [response(before, 'processing', false)];
  const previousCwd = process.cwd();
  process.chdir(web);
  let built;
  try {
    built = await build({
      root: web,
      configFile: false,
      logLevel: 'error',
      esbuild: { jsx: 'automatic' },
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
          input: path.join(web, 'test/browser/fixtures/issue1890-causal-replies.tsx'),
          output: { format: 'es', inlineDynamicImports: true },
        },
      },
    });
  } finally {
    process.chdir(previousCwd);
  }
  const script = built.output.find((item) => item.type === 'chunk' && item.isEntry).code;
  const css = built.output
    .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item) => item.source)
    .join('\n');
  process.stderr.write('issue1890: bundle ready\n');
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const results = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => {
      errors.push(error.message);
      process.stderr.write(`browser: ${error.message}\n`);
    });
    await page.addInitScript(() => localStorage.setItem('cat-cafe:shell-presentation', 'v2'));
    await page.routeWebSocket('**/socket.io/**', (socket) => {
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
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, origin, 'no live service may be contacted');
      if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (url.pathname === '/proof.css') return route.fulfill({ contentType: 'text/css', body: css });
      if (url.pathname.startsWith('/api/')) {
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
        if (url.pathname === '/api/config/process-talk') body = { ownerUserId: 'isolated-owner', mode: 'record' };
        if (url.pathname === '/api/cats')
          body = {
            cats: ['codex', 'dsh'].map((id) => ({
              id,
              displayName: id === 'codex' ? '砚砚' : '鲸鲸',
              name: id,
              clientId: 'openai',
              carrier: 'cli',
              color: { primary: '#987654', secondary: '#eeeeee' },
            })),
          };
        if (url.pathname === '/api/threads')
          body = {
            threads: [
              {
                id: 'issue1890',
                title: '接续正文',
                createdAt: 1,
                createdBy: 'isolated-owner',
                participants: ['codex', 'dsh'],
                projectPath: '/isolated/issue1890',
              },
            ],
          };
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      }
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>',
      });
    });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    process.stderr.write('issue1890: page loaded\n');
    await page.locator('[data-message-id="R"]').waitFor();
    process.stderr.write('issue1890: original mounted\n');
    const styles = await page.evaluate(() => ({
      surface: getComputedStyle(document.documentElement).getPropertyValue('--cafe-surface'),
      font: getComputedStyle(document.body).fontFamily,
    }));
    assert.ok(styles.surface.trim(), 'the real theme stylesheet must be loaded');
    assert.match(styles.font, /Segoe|YaHei|sans-serif/);
    assert.equal(await page.locator('[data-causal-continuation]').count(), 0);
    history = [response(before), input];
    await page.evaluate((messages) => window.issue1890Hydrate(messages), history);
    await page.locator('[data-causal-continuation="R"]').waitFor();
    assert.match(await page.locator('[data-causal-continuation="R"]').innerText(), /等待后续正文/);
    history = [response(before + tail), input];
    await page.evaluate((messages) => window.issue1890Hydrate(messages), history);
    await page.waitForFunction(
      (text) => document.querySelector('[data-causal-continuation="R"]')?.textContent.includes(text),
      tail,
    );
    assert.equal(
      await page
        .locator('[data-causal-original="R"]')
        .innerText()
        .then((text) => text.includes(tail)),
      false,
    );
    assert.equal(await page.locator('[data-message-id="R"]').count(), 1);
    const order = await page
      .locator('[data-message-id="R"], [data-message-id="S"], [data-causal-continuation]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-message-id') ?? 'continuation'));
    assert.deepEqual(order, ['R', 'S', 'continuation']);
    results.push({ stage: 'streaming', order });
    history = [
      response(`${before}${tail}\n\n[砚砚/test]`, 'completed'),
      {
        ...input,
        lifecycle: { ...input.lifecycle, dispatchRefs: [{ ...input.lifecycle.dispatchRefs[0], phase: 'settled' }] },
      },
    ];
    await page.evaluate((messages) => window.issue1890Hydrate(messages), history);
    await page.locator('[data-message-id="S"]').getByRole('button', { name: '看砚砚的回复' }).click();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-causal-continuation')), 'R');
    await page
      .locator('[data-causal-continuation="R"] [data-reply-output-run] p')
      .first()
      .evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      });
    await page.getByTestId('message-selection-add-to-chat').click();
    await page.getByTestId('context-annotation-comment').fill('确认接续引用来源');
    await page.getByTestId('context-annotation-save').click();
    const quote = await page.evaluate(() => window.issue1890LastInsert.contextAttachments[0]);
    assert.equal(quote.source.messageId, 'R');
    assert.equal(quote.selectionStart, before.length);
    assert.equal(quote.selectionEnd, before.length + tail.length);
    assert.equal(quote.text, tail);
    results.push({
      stage: 'quote',
      messageId: quote.source.messageId,
      start: quote.selectionStart,
      end: quote.selectionEnd,
    });
    await page.getByRole('button', { name: '查看完整原文', exact: true }).click();
    assert.match(
      await page.locator('[data-causal-full-text]').innerText(),
      /原来的调用链[\s\S]*收到鲸鲸审查[\s\S]*砚砚\/test/,
    );
    assert.equal((await page.locator('[data-causal-original="R"]').innerText()).split('原来的调用链').length - 1, 1);
    await page.getByRole('button', { name: '收起完整原文', exact: true }).click();
    await page.reload();
    await page.locator('[data-causal-continuation="R"]').waitFor();
    assert.match(await page.locator('[data-causal-continuation="R"]').innerText(), /砚砚\/test/);
    assert.equal(
      (await page.evaluate(() => window.issue1890State())).messages.filter((message) => message.id === 'R').length,
      1,
    );
    for (const width of [1100, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const metrics = await page
        .locator('[data-causal-continuation="R"]')
        .evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
      assert.ok(metrics.scroll <= metrics.width + 1);
      results.push({ stage: 'reload', viewportWidth: width, ...metrics });
      if (process.env.ISSUE1890_EVIDENCE_DIR) {
        await mkdir(process.env.ISSUE1890_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({
          path: path.join(process.env.ISSUE1890_EVIDENCE_DIR, `causal-${width}.png`),
          fullPage: true,
        });
      }
    }
    await page.evaluate(() => window.issue1890Shell('classic'));
    assert.match(await page.locator('[data-causal-continuation="R"]').innerText(), /砚砚\/test/);
    results.push({ stage: 'classic', canonicalCount: await page.locator('[data-message-id="R"]').count() });
    const pendingInput = {
      ...input,
      lifecycle: {
        ...input.lifecycle,
        dispatchRefs: [{ ...input.lifecycle.dispatchRefs[0], appendAcceptance: 'pending' }],
      },
    };
    history = [response(before + tail), pendingInput];
    await page.evaluate((messages) => window.issue1890Hydrate(messages), history);
    await page.waitForFunction(() => document.querySelectorAll('[data-causal-continuation]').length === 0);
    const writtenInput = {
      ...pendingInput,
      lifecycle: {
        ...pendingInput.lifecycle,
        dispatchRefs: [{ ...pendingInput.lifecycle.dispatchRefs[0], appendAcceptance: 'written' }],
      },
    };
    history = [history[0], writtenInput];
    await page.evaluate((messages) => window.issue1890Hydrate(messages), history);
    await page.locator('[data-causal-continuation="R"]').waitFor();
    results.push({ stage: 'native-append', pendingContinuationCount: 0, writtenContinuationCount: 1 });
    history = [
      {
        ...history[0],
        extra: { ...history[0].extra, recall: { version: 1, exposure: 'seen', recalledAt: 5000, exposures: [] } },
      },
      history[1],
    ];
    await page.evaluate((messages) => window.issue1890Hydrate(messages), history);
    await page.waitForFunction(() => document.querySelectorAll('[data-causal-continuation]').length === 0);
    results.push({ stage: 'recalled', continuationCount: 0 });
    await page.evaluate(() => window.issue1890Shell('v2'));
    const native = response(`${before}${tail}\n\n[砚砚/test]`, 'completed');
    const identity = { provider: 'codex', runtimeSessionId: 'native', turnId: 'turn' };
    native.extra.outputLayout = {
      v: 1,
      status: 'available',
      owner: { threadId: 'issue1890', catId: 'codex', turnInvocationId: 'turn' },
      contentRevision: {
        length: native.content.length,
        sha256: createHash('sha256').update(native.content).digest('hex'),
      },
      runs: [
        {
          id: 'process',
          identity: { ...identity, nativeId: 'process' },
          channel: 'commentary',
          complete: true,
          start: 0,
          end: before.length,
          gluePrefixLength: 0,
        },
        {
          id: 'final',
          identity: { ...identity, nativeId: 'final' },
          channel: 'final',
          complete: true,
          start: before.length,
          end: native.content.length,
          gluePrefixLength: 0,
        },
      ],
      order: [
        { kind: 'run', runId: 'process' },
        { kind: 'run', runId: 'final' },
      ],
    };
    const settledInput = {
      ...input,
      lifecycle: { ...input.lifecycle, dispatchRefs: [{ ...input.lifecycle.dispatchRefs[0], phase: 'settled' }] },
    };
    history = [native, settledInput];
    await page.evaluate((messages) => window.issue1890Hydrate(messages), history);
    await page.locator('[data-causal-original="R"] [data-testid="native-reply-answer"]').waitFor({ state: 'attached' });
    assert.equal((await page.locator('[data-causal-original="R"]').innerText()).includes('原来的调用链'), false);
    assert.match(await page.locator('[data-causal-continuation="R"]').innerText(), /收到鲸鲸审查/);
    const recordToggle = page.locator('button[aria-controls="reply-record-R"]');
    if ((await recordToggle.getAttribute('aria-expanded')) === 'false') await recordToggle.click();
    assert.match(await page.locator('#reply-record-R').innerText(), /原来的调用链/);
    results.push({ stage: 'native-output', processInOriginalRecord: true, finalInContinuation: true });
    const second = { ...settledInput, id: 'S2', timestamp: 3000 };
    native.lifecycle.inputMessageIds.push('S2');
    native.lifecycle.inputEntryIds.push('review2');
    native.lifecycle.appendBoundaries.push({ ...boundary, inputMessageId: 'S2' });
    history = [native, settledInput, second];
    await page.evaluate((messages) => window.issue1890Hydrate(messages), history);
    await page.locator('[data-causal-input="S2"]').waitFor();
    await page.locator('[data-message-id="S"]').getByRole('button', { name: '看砚砚的回复' }).click();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-causal-input')), 'S2');
    assert.equal((await page.locator('[data-causal-input="S"]').innerText()).includes(tail), false);
    assert.match(await page.locator('[data-causal-input="S2"]').innerText(), /收到鲸鲸审查/);
    results.push({ stage: 'equal-cut-navigation', from: 'S', focused: 'S2' });
    assert.deepEqual(errors, []);
    if (process.env.ISSUE1890_EVIDENCE_DIR)
      await writeFile(
        path.join(process.env.ISSUE1890_EVIDENCE_DIR, 'browser-results.json'),
        JSON.stringify({ results, errors }, null, 2),
      );
  } finally {
    await browser.close();
  }
});
