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
  browser = await chromium.launch({ headless: true });
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
  context.on('page', (page) => {
    page.setDefaultNavigationTimeout(30_000);
    page.on('pageerror', (error) => process.stderr.write(`Browser page error: ${error.stack}\n`));
  });
  const harness = createChatProofHarness(context, built, evidence, measurements);
  const proof = await harness.openProof({ surface: true, ...options });
  await proof.page.route('**/message-attempts/*', (route) => route.fulfill(json({ status: 'unknown' })));
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

for (const state of ['sending', 'failed', 'unknown']) {
  test(`single-cat view retains a ${state} attempt outside member execution evidence`, async () => {
    const proof = await scene();
    const { page } = proof;
    let held;
    try {
      await page.route('**/api/messages', (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        if (state === 'sending') {
          held = route;
          return;
        }
        return route.fulfill(
          json({ error: state === 'failed' ? '队列已满' : 'response lost' }, state === 'failed' ? 429 : 500),
        );
      });
      await page.getByTestId('conversation-view-menu-toggle').click();
      await page.locator('[data-conversation-cat="codex-astra"]').click();
      await page.locator('[data-single-cat-conversation-timeline]').waitFor();
      await page.locator('textarea').fill('@codex-astra 单猫视图也应保留这条补充');
      await page.locator('textarea').press('Enter');
      const status = page.locator(`[data-send-status="${state}"]`);
      await status.waitFor();
      assert.equal(await status.count(), 1);
      assert.equal(await page.locator('textarea').inputValue(), '');
      assert.equal(
        await status.evaluate(
          (node) => node.closest('[data-conversation-input-evidence], [data-conversation-execution]') === null,
        ),
        true,
      );
      await proof.harness.capture(page, `single-cat-${state}`);
    } finally {
      await held?.abort();
      await proof.finish();
    }
  });
}

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

test('an invalid payload offers copy and editing, and keeps that failure across refresh', async () => {
  const proof = await scene();
  const { page } = proof;
  let posts = 0;
  const text = '这条内容需要调整后再发送。';
  try {
    await page.route('**/api/messages', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      posts++;
      return route.fulfill(json({ error: '请求内容不符合要求' }, 400));
    });
    await page.locator('textarea').fill(text);
    await page.locator('textarea').press('Enter');
    await page.getByRole('button', { name: '复制这条消息的正文' }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: '复制这条消息的正文' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '重试发送这条消息' }).count(), 0);
    await page.evaluate(() =>
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.__copied1973 = text;
          },
        },
      }),
    );
    await page.getByRole('button', { name: '复制这条消息的正文' }).click();
    assert.equal(await page.evaluate(() => window.__copied1973), text);
    assert.equal(posts, 1);
    assert.equal(await page.getByText(text, { exact: true }).count(), 1);
  } finally {
    await proof.finish();
  }
});

test('checking a lost delivery requests canonical History without another submit', async () => {
  const proof = await scene();
  const { page } = proof;
  let posts = 0,
    reads = 0,
    key;
  const text = '回执丢失后，通过核对找到同一条正式消息。';
  try {
    await page.route('**/message-attempts/*', (route) =>
      route.fulfill(json({ status: 'delivered', userMessage: { id: 'checked-canonical', timestamp: 100 } })),
    );
    await page.route('**/api/messages?**', (route) => {
      reads++;
      return route.fulfill(
        json({
          messages: [
            {
              id: 'checked-canonical',
              clientMessageId: key,
              type: 'user',
              from: { kind: 'user', userId: 'owner-proof' },
              catId: null,
              content: text,
              timestamp: Date.now(),
              deliveredAt: Date.now(),
            },
          ],
          hasMore: false,
        }),
      );
    });
    await page.route('**/api/messages', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      posts++;
      key = route.request().postDataJSON().idempotencyKey;
      return route.fulfill(json({ error: 'response lost' }, 500));
    });
    await page.locator('textarea').fill(text);
    await page.locator('textarea').press('Enter');
    await page.locator(`[data-message-viewport-id="checked-canonical"]`).waitFor();
    assert.equal(await page.getByTestId('send-attempt-status').count(), 0);
    assert.equal(await page.getByText(text, { exact: true }).count(), 1);
    assert.ok(reads >= 1);
    assert.equal(posts, 1);
  } finally {
    await proof.finish();
  }
});

test('a disappeared Queue entry is checked and an explicit cancellation cannot reappear as accepted', async () => {
  const proof = await scene();
  const { page } = proof;
  let key,
    canceled = false,
    posts = 0;
  const text = '这条随后被撤回的消息。';
  try {
    await page.route('**/message-attempts/*', (route) =>
      route.fulfill(
        json({ status: canceled ? 'canceled' : 'accepted', userMessage: { id: 'canceled-canonical', timestamp: 100 } }),
      ),
    );
    await page.route('**/api/messages', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      posts++;
      key = route.request().postDataJSON().idempotencyKey;
      return route.fulfill(
        json(
          {
            status: 'queued',
            userMessageId: 'canceled-canonical',
            userMessage: { id: 'canceled-canonical', timestamp: 100 },
          },
          202,
        ),
      );
    });
    await page.locator('textarea').fill(text);
    await page.locator('textarea').press('Enter');
    await page.locator('[data-send-status="accepted"]').waitFor();
    await page.evaluate(
      ({ thread, key, text }) =>
        window.__f322Chat.queue(thread, [
          {
            id: 'queue:canceled-canonical',
            messageId: 'canceled-canonical',
            clientMessageId: key,
            threadId: thread,
            userId: 'owner-proof',
            from: { kind: 'user', userId: 'owner-proof' },
            content: text,
            mergedMessageIds: [],
            targetCats: ['opus'],
            intent: 'execute',
            status: 'queued',
            createdAt: 100,
          },
        ]),
      { thread: CURRENT_THREAD, key, text },
    );
    canceled = true;
    await page.evaluate((thread) => window.__f322Chat.queue(thread, []), CURRENT_THREAD);
    await page.locator('[data-send-status="canceled"]').waitFor();
    assert.equal(await page.getByText(text, { exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '重试发送这条消息' }).count(), 0);
    await page.getByRole('button', { name: '复制这条消息的正文' }).waitFor();
    await page.reload();
    await page.locator('[data-send-status="canceled"]').waitFor();
    assert.equal(await page.getByText(text, { exact: true }).count(), 1);
    assert.equal(await page.locator('textarea').inputValue(), '');
    assert.equal(posts, 1);
    await proof.harness.capture(page, 'desktop-canceled-restored');
  } finally {
    await proof.finish();
  }
});

test('a missing Queue entry with an unavailable receipt stays visible and can be checked without resending', async () => {
  const proof = await scene();
  const { page } = proof;
  let unavailable = false,
    posts = 0;
  try {
    await page.route('**/message-attempts/*', (route) =>
      route.fulfill(
        unavailable
          ? json({}, 503)
          : json({ status: 'accepted', userMessage: { id: 'uncertain-admission', timestamp: 100 } }),
      ),
    );
    await page.route('**/api/messages', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      posts++;
      return route.fulfill(json({ status: 'queued', userMessageId: 'uncertain-admission' }, 202));
    });
    await page.locator('textarea').fill('受理后核对暂时不可用，气泡仍须保留。');
    await page.locator('textarea').press('Enter');
    await page.locator('[data-send-status="accepted"]').waitFor();
    unavailable = true;
    await page.evaluate((thread) => window.__f322Chat.queue(thread, []), CURRENT_THREAD);
    await page.locator('[data-send-status="unknown"]').waitFor();
    await page.getByText('已发出 · 接收状态待确认', { exact: true }).waitFor();
    await page.getByRole('button', { name: '检查这条消息是否发出' }).click();
    await page.locator('[data-send-status="unknown"]').waitFor();
    assert.equal(posts, 1);
    assert.equal(await page.getByRole('button', { name: '重试发送这条消息' }).count(), 0);
    await proof.harness.capture(page, 'desktop-admitted-unconfirmed');
  } finally {
    await proof.finish();
  }
});

for (const unavailable of [false, true]) {
  test(`event-only recall ${unavailable ? 'retains a recoverable copy on 503' : 'merges into the native composer with new typing'}`, async () => {
    const proof = await scene();
    const { page } = proof;
    let posts = 0;
    const text = '等待撤回恢复的原文。';
    try {
      await page.route('**/message-attempts/*', (route) =>
        route.fulfill(json({ status: 'accepted', userMessage: { id: 'recall-canonical', timestamp: 100 } })),
      );
      await page.route('**/api/messages', (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        posts++;
        return route.fulfill(json({ status: 'queued', userMessageId: 'recall-canonical' }, 202));
      });
      await page.locator('textarea').fill(text);
      await page.locator('textarea').press('Enter');
      await page.locator('[data-send-status="accepted"]').waitFor();
      await page.locator('textarea').fill('后来输入的补充。');
      await page.route('**/composer-draft', (route) =>
        route.request().method() === 'GET'
          ? route.fulfill(
              unavailable
                ? json({}, 503)
                : json({
                    draft: {
                      version: 1,
                      ownerUserId: 'owner-proof',
                      threadId: CURRENT_THREAD,
                      revision: 100,
                      text,
                      updatedAt: Date.now(),
                    },
                    revision: 100,
                  }),
            )
          : route.fallback(),
      );
      await page.evaluate((thread) => window.__f322Chat.recall(thread, 'recall-canonical'), CURRENT_THREAD);
      if (unavailable) {
        await page.locator('[data-send-status="recalled"]').waitFor();
        await page.getByText(text, { exact: true }).waitFor();
        await page.getByRole('button', { name: '复制这条消息的正文' }).waitFor();
        await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
        assert.equal(await page.locator('textarea').inputValue(), '后来输入的补充。');
      } else {
        await page.waitForFunction(() => document.querySelector('textarea')?.value.includes('等待撤回恢复的原文。'));
        assert.ok((await page.locator('textarea').inputValue()).includes('后来输入的补充。'));
        assert.equal(await page.getByTestId('send-attempt-status').count(), 0);
      }
      assert.equal(posts, 1);
      await proof.harness.capture(page, unavailable ? 'desktop-recall-recovery-failed' : 'desktop-recall-recovered');
    } finally {
      await proof.finish();
    }
  });
}
