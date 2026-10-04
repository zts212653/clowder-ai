import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CollectiveServiceStore, startCollectiveServer } from '../../../collective-service/dist/index.js';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { defaultHumanAuthProvider, seedDefaultCollective } from './f290-default-client.fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const markdownBody = [
  '**清晰结论**',
  '普通第二行',
  '',
  '- 第一项',
  '- 第二项',
  '',
  '> 这是来自原消息的引用。',
  '',
  '```ts',
  `const longToken = "${'collective-message-body-'.repeat(12)}";`,
  '```',
  '',
  '[安全链接](https://example.com/docs)',
  '[危险链接](javascript:alert(1))',
  '[本地路径](/api/workspace/file)',
  '[邮件链接](mailto:owner@example.com)',
  '<img src=x onerror=alert(1)>',
  '![远程图片](https://tracker.example/pixel.png)',
].join('\n');

const replyBody = '**话题回复**\n\n- 仍然来自同一个 Service event';

async function installOwnerSession(context, serverUrl, seeded) {
  await context.route('https://avatars.fixture.test/owner.jpg', async (route) =>
    route.fulfill({
      contentType: 'image/jpeg',
      body: await readFile(path.join(root, 'packages/web/public/avatars/owner.jpg')),
    }),
  );
  await context.addInitScript(
    ({ origin, token, channelKey }) => {
      if (location.origin === origin) sessionStorage.setItem(`collective-session:${origin}`, token);
      localStorage.setItem(channelKey, '产品方向');
    },
    {
      origin: serverUrl,
      token: seeded.owner.sessionToken,
      channelKey: `collective-channel:${seeded.coordinates.serviceInstanceId}:${seeded.coordinates.collectiveId}:${seeded.owner.human.humanId}`,
    },
  );
}

async function assertSafeProjection(body) {
  await body.getByText('清晰结论', { exact: true }).waitFor();
  assert.equal(await body.getByText('清晰结论', { exact: true }).evaluate((node) => node.tagName), 'STRONG');
  assert.deepEqual(await body.locator('li').allTextContents(), ['第一项', '第二项']);
  assert.equal((await body.locator('blockquote').textContent())?.trim(), '这是来自原消息的引用。');
  const safeLink = body.getByRole('link', { name: '安全链接', exact: true });
  assert.equal(await safeLink.getAttribute('href'), 'https://example.com/docs');
  assert.equal(await safeLink.getAttribute('target'), '_blank');
  for (const label of ['危险链接', '本地路径', '邮件链接']) {
    assert.equal(await body.getByText(label, { exact: true }).evaluate((node) => node.tagName), 'SPAN');
    assert.equal(await body.locator('a').filter({ hasText: label }).count(), 0);
  }
  assert.equal(await body.locator('img').count(), 0);
  assert.match((await body.textContent()) ?? '', /<img src=x onerror=alert\(1\)>/);
  await body.getByText('图片：远程图片', { exact: true }).waitFor();
}

test(
  'Channel and Topic safely project exact persisted Markdown without changing Service source bytes',
  { timeout: 90_000 },
  async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), 'f290-rich-message-journey-'));
    const evidenceDirectory = await mkdtemp(path.join(tmpdir(), 'f290-u2-rich-message-evidence-'));
    const opened = await CollectiveServiceStore.open({
      dataDirectory,
      humanAuthProvider: defaultHumanAuthProvider(),
    });
    const seeded = await seedDefaultCollective(opened.store, opened.bootstrapSecret);
    const source = await opened.store.postHumanMessage(seeded.owner.sessionToken, {
      ...seeded.coordinates,
      clientEventId: 'u2-rich-source',
      body: markdownBody,
      location: { channelId: '产品方向' },
      recipient: { kind: 'channel' },
    });
    const reply = await opened.store.postHumanMessage(seeded.member.sessionToken, {
      ...seeded.coordinates,
      clientEventId: 'u2-rich-reply',
      target: { kind: 'message', eventId: source.eventId },
      replyToEventId: source.eventId,
      body: replyBody,
    });

    const reopened = await CollectiveServiceStore.open({
      dataDirectory,
      humanAuthProvider: defaultHumanAuthProvider(),
    });
    const restored = await reopened.store.listEventsForHuman(
      seeded.owner.sessionToken,
      seeded.coordinates.collectiveId,
    );
    for (const [eventId, expectedBody] of [
      [source.eventId, markdownBody],
      [reply.eventId, replyBody],
    ]) {
      const event = restored.find((candidate) => candidate.eventId === eventId);
      assert.ok(event);
      assert.equal(event.body, expectedBody);
      assert.equal(Buffer.from(event.body).equals(Buffer.from(expectedBody)), true);
    }

    const server = await startCollectiveServer({ store: reopened.store, host: '127.0.0.1', port: 0 });
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
      await installOwnerSession(mobileContext, server.url, seeded);
      const mobile = await mobileContext.newPage();
      const errors = [];
      mobile.on('pageerror', (error) => errors.push(error.message));
      await mobile.goto(server.url, { waitUntil: 'networkidle' });

      const channelArticle = mobile.locator(`article.message[data-event-id="${source.eventId}"]`);
      const channelBody = channelArticle.locator('.message-markdown');
      await assertSafeProjection(channelBody);
      const channelProjection = await channelBody.innerHTML();
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await channelBody.locator('pre').evaluate((pre) => pre.scrollWidth > pre.clientWidth), true);
      await mobile.screenshot({ path: path.join(evidenceDirectory, 'u2-channel-390.png') });

      await channelArticle.getByRole('button', { name: /1 条回复/ }).click();
      const topic = mobile.getByRole('complementary', { name: '话题', exact: true });
      const topicRoot = topic.locator(`.topic-event[data-event-id="${source.eventId}"] .message-markdown`);
      const topicReply = topic.locator(`.topic-event[data-event-id="${reply.eventId}"] .message-markdown`);
      await topicRoot.waitFor();
      assert.equal(await topicRoot.innerHTML(), channelProjection);
      await assertSafeProjection(topicRoot);
      assert.equal(await topicReply.getByText('话题回复', { exact: true }).evaluate((node) => node.tagName), 'STRONG');
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await mobile.screenshot({ path: path.join(evidenceDirectory, 'u2-topic-390.png') });
      await mobileContext.close();

      const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      await installOwnerSession(desktopContext, server.url, seeded);
      const desktop = await desktopContext.newPage();
      await desktop.goto(server.url, { waitUntil: 'networkidle' });
      await assertSafeProjection(
        desktop.locator(`article.message[data-event-id="${source.eventId}"] .message-markdown`),
      );
      assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await desktop.screenshot({ path: path.join(evidenceDirectory, 'u2-channel-1440.png') });
      await desktopContext.close();

      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          result: 'pass',
          evidence: evidenceDirectory,
          tested: [
            'channel-topic-shared-markdown',
            'safe-http-link',
            'dangerous-url-inert',
            'raw-html-escaped',
            'remote-image-inert',
            'mobile-code-contained',
            'service-restart-raw-body-bytes',
          ],
        }),
      );
    } finally {
      await browser?.close();
      await server.close();
      await rm(dataDirectory, { recursive: true });
    }
  },
);
