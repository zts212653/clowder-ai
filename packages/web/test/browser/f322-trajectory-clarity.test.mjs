import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { realSurfaceApiResponse, THREAD_ID } from './f307-real-surface-fixtures.mjs';
import { openWorkspaceTools } from './f307-workspace-open.mjs';
import { cats, detail, exactInput, firstSentence, generations, summary } from './f322-trajectory-data.mjs';
import { runTrajectoryReviewRegressions } from './f322-trajectory-review-journey.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO = path.resolve(WEB_ROOT, '../..');
const OUT =
  process.env.F322_TRAJECTORY_EVIDENCE_DIR ?? path.join(tmpdir(), 'cat-cafe-evidence/f322-trajectory-clarity');
const measurements = [];
let server, browser, nextDev, baseUrl;

before(async () => {
  await mkdir(OUT, { recursive: true });
  const sync = spawnSync(process.execPath, ['scripts/sync-vendor-assets.mjs'], { cwd: WEB_ROOT, encoding: 'utf8' });
  assert.equal(sync.status, 0, sync.stderr);
  const portFinder = createServer();
  portFinder.listen(0, '127.0.0.1');
  await once(portFinder, 'listening');
  const port = portFinder.address().port;
  portFinder.close();
  await once(portFinder, 'close');
  nextDev = await createNextDevTestEnvironment('f322-trajectory-host', {
    NEXT_PUBLIC_API_URL: `http://127.0.0.1:${port}`,
  });
  server = spawn(
    process.execPath,
    [path.join(REPO, 'node_modules/next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', String(port)],
    { cwd: WEB_ROOT, env: nextDev.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = [];
  server.stdout.on('data', (chunk) => output.push(chunk.toString()));
  server.stderr.on('data', (chunk) => output.push(chunk.toString()));
  baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 180000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    assert.equal(server.exitCode, null, output.join(''));
    try {
      ready = (await fetch(`${baseUrl}/thread/${THREAD_ID}`)).ok;
    } catch {
      /* Starting or compiling. */
    }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(ready, output.join(''));
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  if (server?.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  await nextDev?.cleanup();
  await writeFile(
    path.join(OUT, 'measurements.json'),
    JSON.stringify(
      {
        head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
        worktree: REPO,
        baseUrl,
        sourceDiff: execFileSync('git', ['diff', 'HEAD', '--', 'packages/web/src'], { cwd: REPO, encoding: 'utf8' }),
        data: 'synthetic network fixture; production Next app, ChatContainer, F307 host, CSS and resize',
        measurements,
      },
      null,
      2,
    ),
  );
});

async function open(shell, theme, fixture = { summary, detail }, language = 'zh') {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await context.addInitScript(
    ({ shell, theme, language }) => {
      localStorage.setItem('cat-cafe:shell-presentation', shell);
      localStorage.setItem('theme', theme);
      localStorage.setItem('cat-cafe:shell-language', language);
    },
    { shell, theme, language },
  );
  const page = await context.newPage();
  const errors = [],
    calls = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) calls.push(`${request.method()} ${url.pathname}${url.search}`);
  });
  await page.route('**/api/**', (route) => {
    const request = route.request(),
      url = new URL(request.url());
    let response;
    if (url.pathname === '/api/cats') response = { body: { cats } };
    else if (url.pathname.endsWith('/invocations')) response = { body: { invocations: [fixture.summary], total: 1 } };
    else if (url.pathname.includes('/invocations/') && url.pathname.endsWith('/trajectory'))
      response = { body: { invocationId: summary.invocationId, threadId: THREAD_ID, sessionId: summary.sessionId } };
    else if (url.pathname.includes('/sessions/') && url.pathname.includes('/invocations/'))
      response = { body: fixture.detail };
    else if (url.pathname.includes('/sessions/') && url.pathname.endsWith('/events')) {
      const cursor = Number(url.searchParams.get('cursor'));
      const item = fixture.detail.events.find((event) => event.eventNo === cursor);
      response = item
        ? { body: { events: [item], total: fixture.detail.events.length, nextCursor: { eventNo: cursor + 1 } } }
        : { status: 404, body: { error: 'Event not found' } };
    } else if (url.pathname.endsWith('/request-generations'))
      response = { body: generations(url.searchParams.get('reveal') === 'exact') };
    else response = realSurfaceApiResponse(request, false);
    return route.fulfill({
      status: response.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(response.body),
    });
  });
  await page.goto(`${baseUrl}/thread/${THREAD_ID}?shell=${shell}`, { waitUntil: 'networkidle' });
  await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
  const tools = await openWorkspaceTools(page);
  await tools.getByTestId('workspace-launcher-trajectory').click();
  const panel = page.getByTestId('trajectory-panel');
  await panel.waitFor();
  await panel.getByTestId('invocation-trajectory-list').waitFor();
  return { page, context, panel, errors, calls };
}

async function resize(page, target) {
  const host = page.getByTestId('contextual-workspace-host');
  const handle = page.getByRole('separator', { name: /^(右侧面板分隔条|Right panel separator)$/, exact: true });
  for (let n = 0; n < 3; n++) {
    const box = await host.boundingBox(),
      grip = await handle.boundingBox();
    assert(box && grip);
    if (Math.abs(box.width - target) < 3) return;
    const x = grip.x + grip.width / 2,
      y = grip.y + Math.min(200, grip.height / 2);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + box.width - target, y, { steps: 8 });
    await page.mouse.up();
  }
  assert(Math.abs((await host.boundingBox()).width - target) < 3, 'actual Workspace width must match');
}

async function measure(page, name, selector) {
  const result = await page.locator(selector).evaluate((node) => ({
    width: node.getBoundingClientRect().width,
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    descendants: [...node.querySelectorAll('*')]
      .filter(
        (el) =>
          el.clientWidth > 0 &&
          el.scrollWidth > el.clientWidth + 1 &&
          ['auto', 'scroll'].includes(getComputedStyle(el).overflowX),
      )
      .map((el) => ({
        tag: el.tagName,
        text: el.textContent.slice(0, 35),
        width: el.clientWidth,
        scrollWidth: el.scrollWidth,
      })),
  }));
  measurements.push({ name, ...result });
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  assert(result.scrollWidth <= result.clientWidth + 1, `${name} own horizontal scroll: ${JSON.stringify(result)}`);
  assert.deepEqual(
    result.descendants.filter((row) => row.tag !== 'PRE'),
    [],
    `${name} must not hide horizontal overflow in its inner scrolling host`,
  );
  return result;
}

test(
  'v2 real Workspace host: desktop and 420/300px preserve colours, exact keyboard copies, raw and full inputs',
  { timeout: 180000 },
  async () => {
    for (const theme of ['light', 'dark']) {
      const { page, context, panel, errors, calls } = await open('v2', theme);
      try {
        for (const width of [720, 420, 300]) {
          await resize(page, width);
          await measure(page, `v2-${theme}-${width}-list`, '[data-testid="trajectory-panel"]');
          assert.match(await panel.innerText(), /小太阳/);
          assert.equal(await panel.getByTestId('first-assistant-preview').innerText(), firstSentence);
          assert.equal(
            calls.some((call) => call.includes('/sessions/') && call.includes('/invocations/')),
            false,
            'list must not fetch full detail per row',
          );
          const openRow = panel.locator('article > button').first();
          await openRow.focus();
          await page.keyboard.press('Tab');
          assert.equal(await page.locator(':focus').getAttribute('aria-label'), `复制调用 ID：${summary.invocationId}`);
          await page.keyboard.press('Enter');
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), summary.invocationId);
          await page.keyboard.press('Tab');
          assert.equal(await page.locator(':focus').getAttribute('aria-label'), `复制会话 ID：${summary.sessionId}`);
          await page.keyboard.press('Enter');
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), summary.sessionId);
          await openRow.click();
          const detailPanel = page.getByTestId('invocation-trajectory-detail');
          await detailPanel.waitFor();
          await detailPanel.getByText('保留角色颜色与原始记录。', { exact: true }).waitFor();
          const assistantRows = detailPanel.locator('[data-semantic-role="assistant"]');
          // Wait for actionable native cards from the current canonical
          // selection rather than a matching string in another record view.
          await assistantRows.nth(1).waitFor({ state: 'visible' });
          assert.equal(
            await assistantRows.count(),
            2,
            'different native identities and channels stay in separate rows',
          );
          assert.match(await assistantRows.first().innerText(), /由 3 段流式输出拼成/);
          assert.match(await assistantRows.first().innerText(), /过程/);
          assert.match(await assistantRows.last().innerText(), /最终回复/);
          await detailPanel.getByRole('button', { name: '查看首条输出记录', exact: true }).click();
          await detailPanel.getByTestId('first-output-source').getByText('原始记录 #101', { exact: true }).waitFor();
          assert.match(await detailPanel.getByTestId('first-output-source').locator('pre').innerText(), /You，/);
          assert.equal(
            calls.filter(
              (call) =>
                call.slice(call.indexOf(' ') + 1).split('?')[0] ===
                `/api/invocations/${summary.invocationId}/trajectory`,
            ).length,
            1,
            'each reopen resolves its current selection exactly once',
          );
          assert.equal(
            calls.filter(
              (call) =>
                call.slice(call.indexOf(' ') + 1).split('?')[0] ===
                `/api/sessions/${summary.sessionId}/invocations/${summary.invocationId}`,
            ).length,
            1,
            'accepted source reads are not interrupted by a second cached-target detail load',
          );
          await detailPanel.getByRole('button', { name: '‹ 轨迹', exact: true }).focus();
          for (const [kind, value] of [
            ['调用', summary.invocationId],
            ['会话', summary.sessionId],
          ]) {
            await page.keyboard.press('Tab');
            assert.equal(await page.locator(':focus').getAttribute('aria-label'), `复制${kind} ID：${value}`);
            await page.keyboard.press('Enter');
            assert.equal(await page.evaluate(() => navigator.clipboard.readText()), value);
          }
          await measure(page, `v2-${theme}-${width}-detail`, '[data-testid="invocation-trajectory-detail"]');
          assert.equal(
            await detailPanel
              .getByText('输入 1234 · 输出 321', { exact: true })
              .evaluate((node) => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight),
            true,
            'all Token digits must fit without clipping',
          );
          const surfaces = await detailPanel.locator('[data-semantic-role]').evaluateAll((nodes) =>
            nodes.map((node) => ({
              role: node.dataset.semanticRole,
              background: getComputedStyle(node).backgroundImage,
            })),
          );
          const roles = new Map(surfaces.map((row) => [row.role, row.background]));
          for (const role of ['user', 'assistant', 'system', 'context', 'tool', 'error']) assert(roles.has(role), role);
          assert(new Set(roles.values()).size >= 5, 'semantic colour separation remains');
          const unknown = detailPanel.locator('[data-semantic-role="tool"]').filter({ hasText: 'unknown_source' });
          assert.equal((await unknown.innerText()).match(/来源未知/g)?.length, 1);
          assert.match(await unknown.innerText(), /运行中/);
          const input = detailPanel.getByTestId('request-generation-section');
          await input.scrollIntoViewIfNeeded();
          assert.equal(await input.getByText('完整输入末尾标记', { exact: true }).count(), 0);
          await input.getByRole('button', { name: '按来源权限展开' }).click();
          await input.getByText('展开实际提交内容', { exact: true }).click();
          const pre = input.locator('pre');
          assert.equal(await pre.textContent(), exactInput, 'full source body must remain exact');
          await pre.evaluate((node) => {
            node.scrollTop = node.scrollHeight;
          });
          await measure(page, `v2-${theme}-${width}-input`, '[data-testid="invocation-trajectory-detail"]');
          assert.match(await input.innerText(), /来源已删除/);
          assert.match(await input.innerText(), /来源未能核验/);
          await detailPanel.getByRole('button', { name: '原始记录', exact: true }).click();
          assert.equal(await detailPanel.locator('[data-raw-event-no]').count(), 100);
          await detailPanel.getByRole('button', { name: '再显示 100 条' }).click();
          assert.equal(await detailPanel.locator('[data-raw-event-no]').count(), detail.events.length);
          await detailPanel.getByRole('button', { name: '‹ 轨迹', exact: true }).click();
          calls.length = 0;
        }
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  },
);

test(
  'classic real host retains original labels, preview, input ordering and absence of new ID controls',
  { timeout: 90000 },
  async () => {
    const { page, context, panel, errors } = await open('classic', 'light');
    try {
      for (const width of [720, 420, 300]) {
        await resize(page, width);
        assert.match(await panel.innerText(), /Invocations/);
        assert.match(await panel.innerText(), /Session #3/);
        assert.match(await panel.innerText(), /You，/);
        assert.equal(await panel.getByRole('button', { name: /^复制调用 ID/ }).count(), 0);
        await panel.locator('[data-invocation-id]').click();
        const current = page.getByTestId('invocation-trajectory-detail');
        await current
          .locator('[data-semantic-role="assistant"]')
          .filter({ hasText: '保留角色颜色与原始记录。' })
          .waitFor();
        assert.equal(
          await current.locator('[data-semantic-role="assistant"]').count(),
          1,
          'classic retains its original adjacency grouping',
        );
        assert.equal(await current.getByTestId('first-output-source').count(), 0);
        const text = await current.innerText();
        assert(text.indexOf('Input generations') < text.indexOf('保留角色颜色与原始记录。'));
        assert.match(text, /HOST CLI/);
        assert.match(text, /Raw/);
        await page.screenshot({ path: path.join(OUT, `classic-${width}-detail.png`) });
        await current.getByRole('button', { name: '← 返回', exact: true }).click();
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  },
);

test(
  'v2 real host: sentence prefixes are not sentences and invalid roles stay only in raw records',
  { timeout: 180000 },
  () =>
    runTrajectoryReviewRegressions({
      open,
      resize,
      snapshot: (name, page) => page.screenshot({ path: path.join(OUT, `${name}.png`) }),
    }),
);

test(
  'English trajectory content follows the real Host language across list, detail, sessions and search',
  { timeout: 180000 },
  async () => {
    const { page, context, panel, errors, calls } = await open('v2', 'light', { summary, detail }, 'en');
    try {
      await page.route('**/request-generations*', (route) => {
        const data = generations(new URL(route.request().url()).searchParams.get('reveal') === 'exact');
        const envelope = data.generations[0].envelope;
        data.generations[0].terminal = {
          type: 'request_generation_terminal',
          requestGenerationId: envelope.requestGenerationId,
          generationOrdinal: envelope.generationOrdinal,
          terminalAt: 85000,
          outcome: 'accepted',
        };
        data.gaps = [{ kind: 'evidence_gap', fromOrdinal: 2, toOrdinal: 4, state: 'unknown', reason: 'ordinal_gap' }];
        return route.fulfill({ json: data });
      });
      for (const width of [720, 300]) {
        await resize(page, width);
        await panel.getByRole('button', { name: 'Each run', exact: true }).waitFor();
        assert.match(await panel.innerText(), /Done/);
        assert.equal(
          await panel.getByTestId('first-assistant-preview').innerText(),
          firstSentence,
          'native output stays in its original language',
        );
        const copy = panel.getByRole('button', { name: `Copy invocation ID: ${summary.invocationId}`, exact: true });
        await copy.click();
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), summary.invocationId);
        await measure(page, `en-${width}-list`, '[data-testid="trajectory-panel"]');
        await page.screenshot({ path: path.join(OUT, `en-${width}-list.png`) });
        await panel.locator('article > button').first().click();
        const run = page.getByTestId('invocation-trajectory-detail');
        await run.getByText('Trigger input', { exact: true }).waitFor();
        const returnMessage = run.getByRole('button', { name: 'Return to original message', exact: true });
        await returnMessage.waitFor({ state: 'visible' });
        assert.equal(await returnMessage.count(), 1);
        assert.match(await run.innerText(), /Duration/);
        assert.match(await run.innerText(), /Progress/);
        await run.getByRole('button', { name: 'View first-output records', exact: true }).click();
        await run.getByTestId('first-output-source').getByText('Raw record #101', { exact: true }).waitFor();
        const input = run.getByTestId('request-generation-section');
        await input.getByRole('button', { name: 'Expand with source permissions', exact: true }).click();
        await input.getByText('Accepted', { exact: true }).waitFor();
        assert.equal(await input.getByText('Submission record gap #2–4', { exact: true }).count(), 1);
        assert.equal(
          await input.getByText('Compactions: 0 · Input materials: 0 admitted / 0 omitted', { exact: true }).count(),
          1,
        );
        await input.getByText('Expand submitted content', { exact: true }).click();
        assert.equal(await input.locator('pre').textContent(), exactInput);
        await measure(page, `en-${width}-input`, '[data-testid="invocation-trajectory-detail"]');
        await page.screenshot({ path: path.join(OUT, `en-${width}-input.png`) });
        if (width === 300) {
          await input.getByText('Expand submitted content', { exact: true }).click();
          await input.getByText('Accepted', { exact: true }).scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(OUT, 'en-generation-state.png') });
        }
        await run.getByRole('button', { name: 'Raw records', exact: true }).click();
        await run.getByRole('button', { name: 'Show 100 more records', exact: true }).click();
        assert.equal(await run.locator('[data-raw-event-no]').count(), detail.events.length);
        await run.getByRole('button', { name: '‹ Trajectory', exact: true }).click();
      }
      // Controlled HTTP responses exercise the existing real session/search readers;
      // this does not certify provider records, authorization or runtime health.
      await page.route('**/api/threads/**/sessions', (route) =>
        route.fulfill({
          json: {
            sessions: [
              {
                id: 'session-active-language',
                cliSessionId: 'cli-active-language',
                catId: summary.catId,
                seq: 3,
                status: 'active',
                messageCount: 3,
                createdAt: Date.now() - 60000,
              },
              {
                id: summary.sessionId,
                cliSessionId: 'cli-exact-language',
                catId: summary.catId,
                seq: 2,
                status: 'sealed',
                messageCount: 7,
                createdAt: Date.now() - 60000,
                sealedAt: Date.now() - 30000,
                compressionCount: 0,
                sealReason: 'manual',
              },
            ],
          },
        }),
      );
      await panel.getByRole('button', { name: 'Sessions', exact: true }).click();
      await panel.getByRole('heading', { name: 'Session records', exact: true }).waitFor();
      await panel
        .getByRole('button')
        .filter({ hasText: /Archived/ })
        .click();
      await panel.getByText('Session segment 3', { exact: true }).waitFor();
      const segment = panel.getByText('Session segment 3', { exact: true });
      await segment.scrollIntoViewIfNeeded();
      const visibleSegment = await segment.evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const bounds = range.getBoundingClientRect();
        const clippedBy = [];
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          const rect = parent.getBoundingClientRect();
          if (
            /(hidden|clip|auto|scroll)/.test(style.overflowX) &&
            (bounds.left < rect.left - 1 || bounds.right > rect.right + 1)
          ) {
            clippedBy.push(parent.className);
          }
        }
        const painted = node.contains(
          document.elementFromPoint((bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2),
        );
        return { text: node.textContent, width: bounds.width, clippedBy, painted };
      });
      measurements.push({ name: 'en-300-session-segment', ...visibleSegment });
      assert.deepEqual(visibleSegment.clippedBy, [], JSON.stringify(visibleSegment));
      assert.equal(visibleSegment.painted, true, JSON.stringify(visibleSegment));

      await panel.getByRole('button', { name: 'View', exact: true }).click();
      await panel.getByText('Session events', { exact: true }).waitFor();
      await measure(page, 'en-300-sessions', '[data-testid="trajectory-panel"]');
      await page.screenshot({ path: path.join(OUT, 'en-300-sessions.png') });
      // These POSTs are controlled failures in the isolated Host, never writes to
      // a runtime/Alpha session. The server may reject a previously enabled action.
      for (const action of [
        {
          url: '**/api/sessions/session-active-language/seal',
          selector: 'seal-session-session-active-language',
          code: 'SESSION_ACTIVE_INVOCATION',
          raw: '请先停止该 Agent，再封存会话',
          text: 'Stop this Agent before archiving the session.',
        },
        {
          url: '**/api/sessions/session-active-language/seal',
          selector: 'seal-session-session-active-language',
          code: 'SESSION_SEAL_RACE',
          raw: '会话状态已变化，请刷新后重试',
          text: 'The session changed; refresh and try again.',
        },
        {
          url: '**/api/sessions/*/unseal',
          selector: `restore-session-${summary.sessionId}`,
          code: 'active_session_changed',
          raw: '后端恢复冲突',
          text: 'The active session changed; refresh before restoring.',
        },
        {
          url: '**/api/threads/*/sessions/*/compact-native',
          selector: 'compact-native-session-session-active-language',
          code: 'NATIVE_SESSION_BUSY',
          raw: '后端压缩冲突',
          text: 'Wait for this Agent’s work to finish before compacting.',
        },
      ]) {
        await page.route(action.url, (route) =>
          route.fulfill({ status: 409, json: { code: action.code, error: action.raw } }),
        );
        const button = panel.getByTestId(action.selector);
        assert.equal(await button.isEnabled(), true);
        if (action.code === 'active_session_changed') page.once('dialog', (dialog) => dialog.accept());
        await button.click();
        const feedback = panel.getByTestId('session-action-error');
        await feedback.getByText(action.text, { exact: true }).waitFor();
        assert.equal(await feedback.innerText(), action.text);
        assert.equal(
          await panel.getByTestId('session-card-active').count(),
          1,
          'rejection must not manufacture a successful transition',
        );
      }
      await panel.getByTestId('session-action-error').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(OUT, 'en-session-actions.png') });
      await page.route('**/api/threads/**/sessions/search?**', (route) => route.fulfill({ json: { hits: [] } }));
      await panel.getByRole('button', { name: 'Search', exact: true }).click();
      await panel.getByPlaceholder('Search session content…').fill('needle');
      await panel.getByRole('button', { name: 'Search', exact: true }).last().click();
      await panel.getByText('No matching results', { exact: true }).waitFor();
      assert(calls.some((call) => call.includes('q=needle&scope=both')));
      await measure(page, 'en-300-search', '[data-testid="trajectory-panel"]');
      await page.screenshot({ path: path.join(OUT, 'en-300-search.png') });
      const sourceReads = () =>
        calls.filter((call) => /\/invocations|\/sessions|request-generations/.test(call)).length;
      const reads = sourceReads();
      await page.evaluate(() => {
        localStorage.setItem('cat-cafe:shell-language', 'zh');
        window.dispatchEvent(new CustomEvent('cat-cafe:shell-language-sync'));
      });
      await panel.getByRole('button', { name: '每一轮', exact: true }).waitFor();
      assert.equal(sourceReads(), reads, 'language switch must not reload source records');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  },
);
