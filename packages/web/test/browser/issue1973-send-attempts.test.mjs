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

for (const mixed of [false, true]) {
  test(`recall hands off visible and resendable ${mixed ? 'mixed attachments after a partial download failure' : 'ordinary file bytes'}`, async () => {
    const proof = await scene();
    const { page } = proof;
    const text = '撤回后重新编辑有文件的消息';
    const note = Buffer.from('the non-image attachment must survive recall');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Zq5sAAAAASUVORK5CYII=',
      'base64',
    );
    const newer = Buffer.from('new attachment typed during recovery');
    const posts = [];
    let unavailable = mixed;
    try {
      await page.route('**/message-attempts/*', (route) => {
        const key = decodeURIComponent(route.request().url().split('/').pop());
        const index = posts.findIndex((post) => post.key === key);
        return route.fulfill(
          json(
            index < 0
              ? { status: 'unknown' }
              : {
                  status: 'accepted',
                  userMessage: { id: `recall-file-${index + 1}`, timestamp: 100 },
                },
          ),
        );
      });
      await page.route('**/api/messages', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        const request = route.request();
        const type = request.headers()['content-type'];
        if (type.startsWith('multipart/')) {
          const form = await new Response(request.postDataBuffer(), { headers: { 'content-type': type } }).formData();
          const files = await Promise.all(
            form.getAll('images').map(async (file) => ({
              name: file.name,
              bytes: Buffer.from(await file.arrayBuffer()).toString('base64'),
            })),
          );
          posts.push({
            content: form.get('content'),
            key: form.get('idempotencyKey'),
            files,
          });
        } else posts.push({ ...request.postDataJSON(), files: [] });
        return route.fulfill(json({ status: 'queued', userMessageId: `recall-file-${posts.length}` }, 202));
      });
      const uploads = [{ name: 'recall-note.txt', mimeType: 'text/plain', buffer: note }];
      if (mixed) uploads.push({ name: 'recall-local.png', mimeType: 'image/png', buffer: png });
      await page.locator('input[type="file"]').setInputFiles(uploads);
      await page.locator('textarea').fill(text);
      await page.locator('textarea').press('Enter');
      await page.locator('[data-send-status="accepted"]').waitFor();
      const before = await localAttemptFiles(page);
      assert.deepEqual(
        before[0].bytes.sort((a, b) => a - b),
        mixed ? [note.length, png.length] : [note.length],
      );
      await page.route('**/uploads/recalled-note.txt', (route) =>
        route.fulfill(unavailable ? json({}, 503) : { status: 200, contentType: 'text/plain', body: note }),
      );
      await page.route('**/uploads/recalled-local.png', (route) =>
        route.fulfill({ status: 200, contentType: 'image/png', body: png }),
      );
      const blocks = [
        {
          type: 'file',
          url: '/uploads/recalled-note.txt',
          fileName: 'recall-note.txt',
          mimeType: 'text/plain',
          fileSize: note.length,
        },
      ];
      if (mixed) blocks.push({ type: 'image', url: '/uploads/recalled-local.png' });
      let revision = 100;
      let draft = {
        version: 1,
        ownerUserId: 'owner-proof',
        threadId: CURRENT_THREAD,
        revision,
        text,
        contentBlocks: blocks,
        updatedAt: Date.now(),
      };
      await page.route('**/composer-draft', (route) => {
        const request = route.request();
        if (request.method() === 'GET') return route.fulfill(json({ draft, revision }));
        revision++;
        draft = request.method() === 'DELETE' ? null : { ...draft, ...request.postDataJSON(), revision };
        return route.fulfill(json({ draft, revision }));
      });
      await page.evaluate((thread) => window.__f322Chat.recall(thread, 'recall-file-1'), CURRENT_THREAD);
      if (mixed) {
        await page.getByTestId('composer-recovered-attachments-blocked').waitFor();
        assert.deepEqual(await localAttemptFiles(page), before, 'partial file recovery must retain every local byte');
        await page.locator('textarea').fill(`${text}\n\n恢复期间新增正文`);
        await page
          .locator('input[type="file"]')
          .setInputFiles({ name: 'new-during-recall.md', mimeType: 'text/markdown', buffer: newer });
        unavailable = false;
        await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
      }
      await page.getByRole('button', { name: 'Remove recall-note.txt', exact: true }).waitFor();
      await page.locator('[data-send-status="recalled"]').waitFor({ state: 'detached' });
      assert.equal((await localAttemptFiles(page)).length, 0, 'retire only after real file handoff');
      if (mixed) {
        assert.ok((await page.locator('textarea').inputValue()).includes('恢复期间新增正文'));
        await page.getByRole('button', { name: 'Remove new-during-recall.md', exact: true }).waitFor();
      }
      await page.locator('textarea').press('Enter');
      await page.waitForFunction(() => document.querySelector('textarea')?.value === '');
      assert.equal(posts.length, 2);
      assert.equal(posts[1].files.find((file) => file.name === 'recall-note.txt')?.bytes, note.toString('base64'));
      assert.equal(posts[1].files.length, mixed ? 3 : 1);
      if (mixed) {
        assert.ok(posts[1].files.some((file) => file.bytes === png.toString('base64')));
        assert.equal(
          posts[1].files.find((file) => file.name === 'new-during-recall.md')?.bytes,
          newer.toString('base64'),
        );
      }
    } finally {
      await proof.finish();
    }
  });
}

async function localAttemptFiles(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('cat-cafe-send-attempts', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const read = db.transaction('attempts').objectStore('attempts').getAll();
          read.onsuccess = () => {
            resolve(read.result.map((row) => ({ id: row.id, bytes: row.files.map((file) => file.bytes.byteLength) })));
            db.close();
          };
          read.onerror = () => {
            db.close();
            reject(read.error);
          };
        };
      }),
  );
}

for (const addedText of ['', '保存失败期间新增的输入']) {
  test(`a local persistence retry transfers only its original composer snapshot ${addedText ? 'with new typing' : 'without another POST'}`, async () => {
    const proof = await scene();
    const { page } = proof;
    const text = '本地配额恢复后只发送这条一次';
    const posts = [];
    try {
      await page.route('**/message-attempts/*', (route) => {
        const key = decodeURIComponent(route.request().url().split('/').pop());
        const index = posts.findIndex((post) => post.idempotencyKey === key);
        return route.fulfill(
          json(
            index < 0
              ? { status: 'unknown' }
              : { status: 'accepted', userMessage: { id: `quota-retried-${index + 1}`, timestamp: 100 } },
          ),
        );
      });
      await page.route('**/api/messages', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        const request = route.request();
        const type = request.headers()['content-type'];
        if (type.startsWith('multipart/')) {
          const form = await new Response(request.postDataBuffer(), { headers: { 'content-type': type } }).formData();
          posts.push({
            content: form.get('content'),
            idempotencyKey: form.get('idempotencyKey'),
            imageName: form.get('images')?.name,
            imageBytes: form.get('images')?.size,
          });
        } else posts.push(request.postDataJSON());
        return route.fulfill(json({ status: 'queued', userMessageId: `quota-retried-${posts.length}` }, 202));
      });
      await page.evaluate(() => {
        const original = IDBObjectStore.prototype.put;
        let failOnce = true;
        IDBObjectStore.prototype.put = function (...args) {
          if (this.name === 'attempts' && failOnce) {
            failOnce = false;
            throw new DOMException('simulated quota exceeded', 'QuotaExceededError');
          }
          return original.apply(this, args);
        };
      });
      await page.locator('textarea').fill(text);
      await page.locator('textarea').press('Enter');
      await page.locator('[data-send-status="failed"]').waitFor();
      assert.equal(await page.locator('textarea').inputValue(), text);
      assert.equal(posts.length, 0);
      if (addedText) {
        await page.locator('textarea').fill(`${text}\n\n${addedText}`);
        await page.locator('input[type="file"]').setInputFiles({
          name: 'retry-new.png',
          mimeType: 'image/png',
          buffer: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Zq5sAAAAASUVORK5CYII=',
            'base64',
          ),
        });
        await page.getByRole('button', { name: 'Remove retry-new.png', exact: true }).waitFor();
      }
      await page.getByRole('button', { name: '重试发送这条消息' }).click();
      await page.locator('[data-send-status="accepted"]').waitFor();
      assert.equal(posts.length, 1);
      assert.equal(await page.locator('textarea').inputValue(), addedText ? `\n\n${addedText}` : '');
      await page.locator('textarea').press('Enter');
      if (addedText) {
        await page.waitForFunction(() => document.querySelector('textarea')?.value === '');
        assert.equal(posts.length, 2);
        assert.equal(posts[1].content, addedText);
        assert.equal(posts[1].imageName, 'retry-new.png');
        assert.equal(posts[1].imageBytes, 68);
      } else {
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        assert.equal(posts.length, 1);
      }
      assert.equal(posts.filter((post) => post.content === text).length, 1);
    } finally {
      await proof.finish();
    }
  });
}

test('a recalled attachment keeps its local bytes until the mounted draft restores the image', async () => {
  const proof = await scene();
  const { page } = proof;
  const text = '撤回带图内容应保留离线副本';
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Zq5sAAAAASUVORK5CYII=',
    'base64',
  );
  let unavailable = true;
  try {
    await page.route('**/message-attempts/*', (route) =>
      route.fulfill(json({ status: 'accepted', userMessage: { id: 'recall-image-local', timestamp: 100 } })),
    );
    await page.route('**/api/messages', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill(json({ status: 'queued', userMessageId: 'recall-image-local' }, 202))
        : route.fallback(),
    );
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: 'recall-local.png', mimeType: 'image/png', buffer: png });
    await page.locator('textarea').fill(text);
    await page.locator('textarea').press('Enter');
    await page.locator('[data-send-status="accepted"]').waitFor();
    const before = await localAttemptFiles(page);
    assert.deepEqual(
      before.map((row) => row.bytes),
      [[png.length]],
    );
    await page.route('**/uploads/recalled-local.png', (route) =>
      route.fulfill(unavailable ? json({}, 503) : { status: 200, contentType: 'image/png', body: png }),
    );
    await page.route('**/composer-draft', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill(
            json({
              draft: {
                version: 1,
                ownerUserId: 'owner-proof',
                threadId: CURRENT_THREAD,
                revision: 100,
                text,
                contentBlocks: [{ type: 'image', url: '/uploads/recalled-local.png' }],
                updatedAt: Date.now(),
              },
              revision: 100,
            }),
          )
        : route.fallback(),
    );
    await page.evaluate((thread) => window.__f322Chat.recall(thread, 'recall-image-local'), CURRENT_THREAD);
    await page.getByTestId('composer-recovered-attachments-blocked').waitFor();
    assert.deepEqual(
      await localAttemptFiles(page),
      before,
      'failed image restoration must keep the original durable bytes',
    );
    await page.locator('[data-send-status="recalled"]').waitFor();
    await page.locator('textarea').fill(`${text}\n\n恢复期间新增输入`);
    unavailable = false;
    await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
    await page.locator('[data-send-status="recalled"]').waitFor({ state: 'detached' });
    assert.equal((await localAttemptFiles(page)).length, 0);
    assert.ok((await page.locator('textarea').inputValue()).includes('恢复期间新增输入'));
    assert.equal(await page.getByTestId('composer-recovered-attachments-blocked').count(), 0);
  } finally {
    await proof.finish();
  }
});

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
      // The same row can already be checking its unknown receipt by this turn.
      // Assert persistent visibility independently from that transient status.
      const visibleAttempt = page.getByTestId('send-attempt-status');
      assert.equal(await visibleAttempt.count(), 1);
      assert.equal(await page.locator('textarea').inputValue(), '');
      assert.equal(
        await visibleAttempt.evaluate(
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
    await page.route('**/message-attempts/*', (route) =>
      route.fulfill(json({ status: 'accepted', userMessage: { id: 'accepted-1973', timestamp: 100 } })),
    );
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
    await page.route('**/message-attempts/*', (route) =>
      route.fulfill(
        requests.length > 1
          ? json({ status: 'accepted', userMessage: { id: 'retried-1973', timestamp: 100 } })
          : json({ status: 'unknown' }),
      ),
    );
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
