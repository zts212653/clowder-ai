import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReadbackCapture } from '../fixtures/f322-readback-public-projection.mjs';
import { realSurfaceApiResponse, THREAD_ID } from './f307-real-surface-fixtures.mjs';
import {
  beginNativeActionFrames,
  finishNativeActionFrames,
  observeNativeReading,
  saveNativeActionFailure,
  verifyNativeHistoryOwner,
  waitForNativeActionMeasurement,
} from './f322-native-reply-reading.mjs';
import { verifyNativeScrollport } from './f322-native-reply-scrollport.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repo = path.resolve(webRoot, '../..');

export async function startNativeHost() {
  const sync = spawnSync(process.execPath, ['scripts/sync-vendor-assets.mjs'], { cwd: webRoot, encoding: 'utf8' });
  assert.equal(sync.status, 0, sync.stderr);
  const finder = createServer();
  finder.listen(0, '127.0.0.1');
  await once(finder, 'listening');
  const port = finder.address().port;
  finder.close();
  await once(finder, 'close');
  const isolation = await createNextDevTestEnvironment('f322-native-reply', {
    NEXT_PUBLIC_API_URL: `http://127.0.0.1:${port}`,
    API_SERVER_PORT: String(port),
  });
  const server = spawn(
    process.execPath,
    [path.join(repo, 'node_modules/next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', String(port)],
    {
      cwd: webRoot,
      env: isolation.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const logs = [];
  server.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  server.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  return {
    url: `http://127.0.0.1:${port}`,
    async ready() {
      const until = Date.now() + 180000;
      while (Date.now() < until) {
        assert.equal(server.exitCode, null, logs.slice(-30).join(''));
        try {
          if ((await fetch(`http://127.0.0.1:${port}/thread/${THREAD_ID}`)).ok) return;
        } catch {
          /* compiling */
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert.fail(logs.slice(-30).join(''));
    },
    async close() {
      if (server.exitCode === null) {
        server.kill('SIGTERM');
        await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
        if (server.exitCode === null) server.kill('SIGKILL');
      }
      await isolation.cleanup();
    },
  };
}

export function readbackResponse(request, trace, message) {
  const url = new URL(request.url());
  const thread = {
    id: trace.threadId,
    title: 'Native reply readback',
    projectPath: '/project/cat-cafe',
    createdBy: trace.userId,
  };
  if (url.pathname === '/api/messages') return { body: { messages: [message], hasMore: false } };
  if (url.pathname === '/api/session') return { body: { userId: trace.userId } };
  if (url.pathname === '/api/threads') return { body: { threads: [thread] } };
  if (url.pathname === `/api/threads/${trace.threadId}`) return { body: thread };
  if (url.pathname === '/api/cats')
    return {
      body: {
        cats: [
          {
            id: 'codex',
            displayName: '缅因猫',
            breedId: 'maine-coon',
            avatar: '/avatars/codex.png',
            color: { primary: '#5B8C5A', secondary: '#eeeeee' },
            mentionPatterns: ['@codex'],
            carrier: 'cli',
            clientId: 'openai',
            defaultModel: 'gpt-6.1-sol',
            roster: { available: true },
          },
        ],
      },
    };
  return realSurfaceApiResponse(
    {
      url: () => request.url().replace(trace.threadId, THREAD_ID),
      method: () => request.method(),
      postData: () => request.postData(),
    },
    false,
  );
}

async function chooseAnswer(page, row) {
  const selected = row.locator('[data-reply-output-kind="answer"] strong').first();
  await selected.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.keyboard.press('ControlOrMeta+c');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '答案段');
  await page.getByTestId('message-selection-add-to-chat').click();
  const editor = page.getByTestId('context-annotation-editor');
  assert.equal(await editor.locator('blockquote').innerText(), '答案段');
  await editor.getByTestId('context-annotation-comment').fill('保留这段已证回答');
  const save = editor.getByTestId('context-annotation-save');
  assert(await save.isEnabled(), 'the existing quote confirmation is enabled after a real comment');
  await save.click();
  await editor.waitFor({ state: 'hidden' });
}

async function verifyRecordSummaryRecovery(page, row, out, name, width, language) {
  if (language !== 'en' || (width !== 300 && width !== 1440)) return;
  const toggle = row.getByTestId('reply-record-toggle');
  const text = toggle.locator('span').first();
  const summary = await text.innerText();
  const truncated = await text.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
  assert.equal(truncated, width === 300, `${name}: actual summary overflow`);
  await toggle.hover();
  const tip = page.getByRole('tooltip').filter({ hasText: summary });
  if (truncated) {
    await tip.waitFor();
    assert.equal(await tip.innerText(), summary);
    if (out) await page.screenshot({ path: path.join(out, `${name}-summary-hover.png`) });
    await page.keyboard.press('Escape');
    await tip.waitFor({ state: 'hidden' });
  } else assert.equal(await tip.count(), 0, 'full-width summary needs no tooltip');
  await page.mouse.move(0, 0);
  await toggle.evaluate((node) => node.blur());
  await page.keyboard.press('Tab');
  await toggle.focus();
  if (truncated) {
    await tip.waitFor();
    assert.equal(await tip.innerText(), summary);
    if (out) await page.screenshot({ path: path.join(out, `${name}-summary-focus.png`) });
    await page.keyboard.press('Escape');
    await tip.waitFor({ state: 'hidden' });
  } else assert.equal(await tip.count(), 0);
  await toggle.evaluate((node) => node.blur());
}

async function visitNativeScenario(browser, host, trace, out, measurements, shell, theme, language, touch = false) {
  const scenario = `${shell}-${theme}-${language}${touch ? '-coarse' : ''}`;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ['clipboard-read', 'clipboard-write'],
    hasTouch: touch,
  });
  let page;
  try {
    await context.addInitScript(
      ({ shell, theme, language }) => {
        localStorage.setItem('cat-cafe:shell-presentation', shell);
        localStorage.setItem('cat-cafe:shell-language', language);
        localStorage.setItem('theme', theme);
      },
      { shell, theme, language },
    );
    page = await context.newPage();
    const errors = [];
    let message = trace.api;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/**', async (route) => {
      const response = readbackResponse(route.request(), trace, message);
      await route.fulfill({
        status: response.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(response.body),
      });
    });
    await page.goto(`${host.url}/thread/${trace.threadId}?shell=${shell}`, { waitUntil: 'networkidle' });
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
    let row = page.locator(`[data-message-id="${message.id}"]`).last();
    if (shell === 'classic') {
      assert.equal(await row.locator('[data-testid="native-reply-answer"]').count(), 0);
      assert.match(await row.innerText(), /检查|日志/);
      await observeNativeReading(page, row, out, `${scenario}-desktop`, measurements);
      return;
    }
    await row.getByTestId('native-reply-answer').waitFor();
    // Use the ordinary reading state before resizing: a desktop-open sidebar
    // otherwise becomes a mobile drawer that obscures the conversation.
    await page.getByTestId('sidebar-collapse').click();
    await page.getByTestId('sidebar-collapse').waitFor({ state: 'hidden' });
    await page.getByTestId('header-sidebar-expand').waitFor();
    assert.equal(await row.locator('[data-reply-output-kind="answer"] strong').innerText(), '答案段');
    assert.match(await row.getByTestId('native-reply-answer').innerText(), /Sol\/gpt-6.1-sol🐾/);
    assert.doesNotMatch(await row.getByTestId('native-reply-answer').innerText(), /检查|日志/);
    assert.match(
      await row.getByTestId('reply-last-line').innerText(),
      language === 'zh' ? /过程\s*1\s*段/ : /1 process segment/,
    );
    const toggle = row.getByTestId('reply-record-toggle');
    await toggle.focus();
    await page.keyboard.press('Enter');
    const process = row.locator('[data-reply-output-kind="process"]');
    await process.waitFor();
    assert.match(await process.innerText(), /检查.*日志/);
    assert.equal(await row.locator('[data-testid^="reply-record-tool-"]').count(), 1);
    await beginNativeActionFrames(page, message.id);
    for (const [step, width] of [1440, 420, 300, 720, 300, 420, 1440].entries()) {
      await page.setViewportSize({ width, height: 1000 });
      await waitForNativeActionMeasurement(page, message.id, width);
      await observeNativeReading(page, row, out, `${scenario}-${width}-step${step}`, measurements);
      await verifyRecordSummaryRecovery(page, row, out, `${scenario}-${width}-step${step}`, width, language);
    }
    await finishNativeActionFrames(page, out, `${scenario}`);
    await verifyNativeScrollport(page, row, out, scenario);
    await verifyNativeHistoryOwner(page, message.id);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await chooseAnswer(page, row);
    await page.reload({ waitUntil: 'networkidle' });
    row = page.locator(`[data-message-id="${trace.api.id}"]`).last();
    await row.getByTestId('native-reply-answer').waitFor();
    assert.doesNotMatch(await row.getByTestId('native-reply-answer').innerText(), /检查|日志/);
    message = trace.draft.api;
    await page.reload({ waitUntil: 'networkidle' });
    row = page.locator(`[data-message-id="${message.id}"]`).last();
    await row.getByTestId('native-reply-answer').waitFor();
    assert.match(
      await row.getByTestId('reply-last-line').innerText(),
      language === 'zh' ? /过程\s*1\s*段/ : /1 process segment/,
    );
    message = {
      ...trace.api,
      content: '旧记录或失败前的过程仍可读。',
      extra: { ...trace.api.extra, outputLayout: undefined },
    };
    await page.reload({ waitUntil: 'networkidle' });
    row = page.locator(`[data-message-id="${message.id}"]`).last();
    assert.equal(await row.getByTestId('native-reply-answer').count(), 0);
    assert.match(await row.innerText(), /旧记录或失败前的过程仍可读/);
    assert.deepEqual(errors, []);
  } catch (error) {
    if (out && page) {
      await saveNativeActionFailure(page, out, `${scenario}`);
      const name = `${scenario}-failure`;
      await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
      await writeFile(path.join(out, `${name}-dom.txt`), await page.locator('body').innerText());
      await writeFile(
        path.join(out, `${name}-diagnostics.json`),
        `${JSON.stringify(
          await page.evaluate(
            (id) => ({
              secure: window.isSecureContext,
              cryptoAvailable: Boolean(window.crypto?.subtle),
              rows: [...document.querySelectorAll(`[data-message-id="${id}"]`)].map((node) => ({
                tag: node.tagName,
                testid: node.getAttribute('data-testid'),
                text: node.textContent,
                nativeAnswers: node.querySelectorAll('[data-testid="native-reply-answer"]').length,
              })),
            }),
            trace.api.id,
          ),
          null,
          2,
        )}\n`,
      );
    }
    throw error;
  } finally {
    await context.close();
  }
}

/** Uses the public capture projection (or a fresh actual override) in Next ChatContainer. */
export async function runNativeReplyNextJourney(browser, evidenceDir) {
  const data = loadReadbackCapture();
  assert.equal(data.redisPort, 6398);
  const trace = data.traces[0];
  const out =
    process.env.F322_NATIVE_REPLY_EVIDENCE_DIR ?? (evidenceDir ? path.join(evidenceDir, 'native-next') : undefined);
  if (out) await mkdir(out, { recursive: true });
  const host = await startNativeHost();
  const measurements = [];
  try {
    await host.ready();
    for (const shell of ['v2', 'classic']) {
      for (const theme of ['light', 'dark']) {
        for (const language of ['zh', 'en']) {
          await visitNativeScenario(browser, host, trace, out, measurements, shell, theme, language);
        }
      }
    }
    await visitNativeScenario(browser, host, trace, out, measurements, 'v2', 'light', 'zh', true);
  } finally {
    await host.close();
    if (out)
      await writeFile(
        path.join(out, 'measurements.json'),
        `${JSON.stringify(
          {
            head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
            source: `${data.provenance?.kind ?? 'actual Redis/API synthetic capture override'} → production Next/ChatContainer; actual browser crypto`,
            measurements,
          },
          null,
          2,
        )}\n`,
      );
  }
}
