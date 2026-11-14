import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { createChatProofHarness } from './f322-chat-proof-harness.mjs';
import { buildChatProof, webRoot } from './fixtures/f322-chat-real-page-build.mjs';
import { CURRENT_THREAD } from './fixtures/f322-chat-real-page-data.mjs';

const evidence = path.resolve(webRoot, '../../.cat-cafe/tmp/issue1973-browser');
const measurements = [];
let browser, built;
before(async () => {
  await mkdir(evidence, { recursive: true });
  built = await buildChatProof();
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
});
after(async () => {
  await browser?.close();
  await writeFile(
    path.join(evidence, 'verification.json'),
    JSON.stringify(
      {
        scope:
          'Production conversation surface and actual IndexedDB; controlled HTTP/socket boundary, not live provider acceptance.',
        measurements,
      },
      null,
      2,
    ),
  );
});
async function scene(options = {}) {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const harness = createChatProofHarness(context, built, evidence, measurements);
  const proof = await harness.openProof({ surface: true, ...options });
  const finish = async () => {
    try {
      await harness.closeProof(proof);
    } finally {
      await context.close();
    }
  };
  return { ...proof, harness, finish };
}
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

test('real composer paints a bubble before POST returns and hands off in place to the canonical message', async () => {
  const proof = await scene();
  const { page, harness } = proof;
  let held;
  const text = '先保留这条补充消息，不必再发一次。';
  try {
    await page.route('**/api/messages', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      held = route;
    });
    await page.locator('textarea').fill(text);
    await page.locator('textarea').press('Enter');
    const status = page.getByTestId('send-attempt-status');
    await status.locator(':scope[data-send-status="sending"]').waitFor();
    assert.equal(await page.getByText(text, { exact: true }).count(), 1);
    assert.equal(await page.locator('textarea').inputValue(), '');
    const body = held.request().postDataJSON();
    const originalRow = await page
      .getByText(text, { exact: true })
      .evaluateHandle((element) => element.closest('[data-message-viewport-boundary]'));
    await harness.capture(page, 'desktop-sending');
    await held.fulfill(
      json(
        {
          status: 'queued',
          userMessageId: 'accepted-1973',
          userMessage: { id: 'accepted-1973', timestamp: Date.now() },
        },
        202,
      ),
    );
    await page.locator('[data-send-status="accepted"]').waitFor();
    await page.evaluate(
      ({ thread, text, key }) =>
        window.__f322Chat.incoming(thread, {
          id: 'accepted-1973',
          clientMessageId: key,
          from: { kind: 'user', userId: 'owner-proof' },
          type: 'user',
          content: text,
          timestamp: Date.now(),
          deliveredAt: Date.now(),
        }),
      { thread: CURRENT_THREAD, text, key: body.idempotencyKey },
    );
    await status.waitFor({ state: 'detached' });
    assert.equal(await page.getByText(text, { exact: true }).count(), 1);
    assert.equal(
      await originalRow.evaluate((element) => element?.isConnected),
      true,
      'canonical handoff keeps the same visible row',
    );
    await harness.capture(page, 'desktop-delivered');
  } finally {
    await proof.finish();
  }
});

test('known refusal retains its bubble and retries the identical payload with the identical key', async () => {
  const proof = await scene();
  const { page, harness } = proof;
  const requests = [];
  const text = '这条明确被拒收的消息应当可以重试。';
  try {
    await page.route('**/api/messages', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      requests.push(route.request().postDataJSON());
      return route.fulfill(
        requests.length === 1
          ? json({ error: '消息队列已满', code: 'QUEUE_FULL' }, 429)
          : json(
              {
                status: 'queued',
                userMessageId: 'retried-1973',
                userMessage: { id: 'retried-1973', timestamp: Date.now() },
              },
              202,
            ),
      );
    });
    await page.locator('textarea').fill(text);
    await page.locator('textarea').press('Enter');
    await page.locator('[data-send-status="failed"]').waitFor();
    assert.equal(await page.getByText(text, { exact: true }).count(), 1);
    await harness.capture(page, 'desktop-failed');
    await page.getByRole('button', { name: '重试发送这条消息' }).click();
    await page.locator('[data-send-status="accepted"]').waitFor();
    assert.deepEqual(requests[1], requests[0]);
    assert.equal(await page.getByText(text, { exact: true }).count(), 1);
  } finally {
    await proof.finish();
  }
});

test('unknown survives refresh on a narrow dark page; checking performs no additional POST', async () => {
  const proof = await scene({ width: 390, sidebar: false, base: 'dark' });
  const { page, harness } = proof;
  let posts = 0,
    checks = 0;
  const text = '连接中断后，这条消息仍应留在原处。';
  try {
    await page.route('**/message-attempts/*', (route) => {
      checks++;
      return route.fulfill(json({ status: 'unknown' }));
    });
    await page.route('**/api/messages', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      posts++;
      return route.fulfill(json({ error: 'response unavailable' }, 500));
    });
    await page.locator('textarea').fill(text);
    await page.locator('textarea').press('Enter');
    await page.locator('[data-send-status="unknown"]').waitFor();
    await page.reload();
    await page.locator('[data-send-status="unknown"]').waitFor();
    assert.equal(await page.getByText(text, { exact: true }).count(), 1);
    const prior = checks;
    await page.getByRole('button', { name: '检查这条消息是否发出' }).click();
    await page.locator('[data-send-status="unknown"]').waitFor();
    assert.ok(checks > prior);
    assert.equal(posts, 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const button = await page.getByRole('button', { name: '检查这条消息是否发出' }).boundingBox();
    assert.ok(button.height >= 44);
    await harness.capture(page, 'narrow-dark-unknown-restored');
  } finally {
    await proof.finish();
  }
});

test('a rejected attachment and its text survive refresh, and retry sends the same bytes and key', async () => {
  const proof = await scene();
  const { page } = proof;
  const bodies = [];
  const text = '附件和这句话都需要保留。';
  try {
    await page.route('**/api/messages', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      bodies.push(route.request().postDataBuffer().toString('utf8'));
      return route.fulfill(json({ error: '队列已满', code: 'QUEUE_FULL' }, 429));
    });
    await page.locator('input[type="file"]').setInputFiles({
      name: 'acceptance-note.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('issue1973-persistent-file-bytes'),
    });
    await page.locator('textarea').fill(text);
    await page.locator('textarea').press('Enter');
    await page.locator('[data-send-status="failed"]').waitFor();
    assert.equal(await page.getByText(text, { exact: true }).count(), 1);
    await page.reload();
    await page.locator('[data-send-status="failed"]').waitFor();
    assert.equal(await page.getByText(text, { exact: true }).count(), 1);
    await page.getByText('acceptance-note.txt', { exact: true }).waitFor();
    await page.getByRole('button', { name: '重试发送这条消息' }).click();
    await page.waitForFunction(() => document.querySelector('[data-send-status="failed"]'));
    assert.equal(bodies.length, 2);
    const key = (body) => body.match(/name="idempotencyKey"\r\n\r\n([^\r]+)/)?.[1];
    assert.ok(key(bodies[0]));
    assert.equal(key(bodies[1]), key(bodies[0]));
    for (const body of bodies) {
      assert.ok(body.includes('issue1973-persistent-file-bytes'));
      assert.ok(body.includes(text));
    }
  } finally {
    await proof.finish();
  }
});
