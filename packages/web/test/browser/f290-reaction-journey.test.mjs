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

async function assertTouchMenuWithinFlow(page, menu, flow, lastItemLabel) {
  const [menuBox, flowBox, lastItemBox] = await Promise.all([
    menu.boundingBox(),
    flow.boundingBox(),
    menu.getByRole('menuitem', { name: lastItemLabel, exact: true }).boundingBox(),
  ]);
  const viewport = page.viewportSize();
  assert.ok(menuBox && flowBox && lastItemBox && viewport);
  assert.ok(menuBox.y >= Math.max(0, flowBox.y) - 1, 'touch menu stays above the scroll boundary');
  assert.ok(
    menuBox.y + menuBox.height <= Math.min(viewport.height, flowBox.y + flowBox.height) + 1,
    'touch menu stays above the Composer-side scroll boundary',
  );
  assert.ok(lastItemBox.y >= menuBox.y && lastItemBox.y + lastItemBox.height <= menuBox.y + menuBox.height);
}

test(
  'Channel and Topic share compact pointer, touch, keyboard, focus and reaction behavior',
  { timeout: 90_000 },
  async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), 'f290-reaction-journey-'));
    const evidenceDirectory = await mkdtemp(path.join(tmpdir(), 'f290-u1-message-evidence-'));
    const opened = await CollectiveServiceStore.open({
      dataDirectory,
      humanAuthProvider: defaultHumanAuthProvider(),
    });
    const seeded = await seedDefaultCollective(opened.store, opened.bootstrapSecret);
    const short = await opened.store.postHumanMessage(seeded.owner.sessionToken, {
      ...seeded.coordinates,
      clientEventId: 'u1-one-character-message',
      body: '喵',
      location: { channelId: '产品方向' },
      recipient: { kind: 'channel' },
    });
    let topicTail;
    for (let index = 0; index < 8; index += 1) {
      topicTail = await opened.store.postHumanMessage(seeded.member.sessionToken, {
        ...seeded.coordinates,
        clientEventId: `u1-topic-tail-${index}`,
        target: { kind: 'message', eventId: short.eventId },
        replyToEventId: short.eventId,
        body: index === 7 ? '话题末尾回应' : `让话题形成真实滚动边界 · ${index + 1}`,
      });
    }
    assert.ok(topicTail);
    await opened.store.setCollectiveReaction(seeded.member.sessionToken, {
      ...seeded.coordinates,
      requestId: 'member-seeds-paw-reaction',
      eventId: seeded.first.eventId,
      emoji: '🐾',
      active: true,
    });
    await opened.store.setCollectiveReaction(seeded.member.sessionToken, {
      ...seeded.coordinates,
      requestId: 'member-seeds-topic-tail-reaction',
      eventId: topicTail.eventId,
      emoji: '👍',
      active: true,
    });
    const server = await startCollectiveServer({ store: opened.store, host: '127.0.0.1', port: 0 });
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
      await installOwnerSession(mobileContext, server.url, seeded);
      const mobile = await mobileContext.newPage();
      let firstReactionRoute;
      let reactionRequestCount = 0;
      const reactionRequests = [];
      await mobile.route('**/api/collaboration/reactions/set', async (route) => {
        reactionRequestCount += 1;
        reactionRequests.push(route.request().postDataJSON());
        if (reactionRequestCount === 1) {
          firstReactionRoute = route;
          return;
        }
        await route.continue();
      });
      const errors = [];
      mobile.on('pageerror', (error) => errors.push(error.message));
      await mobile.goto(server.url, { waitUntil: 'networkidle' });
      await mobile.getByRole('heading', { name: '# 产品方向', exact: true }).waitFor();

      let shortArticle = mobile.locator('article.message').filter({ hasText: short.body });
      await shortArticle.waitFor();
      assert.equal(await shortArticle.locator('.reaction-bar').count(), 0);
      assert.equal(await shortArticle.getByText('发起随手投票', { exact: true }).count(), 0);
      assert.equal(await shortArticle.getByText('整理为工作', { exact: true }).count(), 0);
      let mobileMore = shortArticle.getByRole('button', { name: '更多消息动作', exact: true });
      const mobileMoreBox = await mobileMore.boundingBox();
      assert.ok(mobileMoreBox && mobileMoreBox.width >= 44 && mobileMoreBox.height >= 44);
      assert.equal(
        await shortArticle
          .locator('button[aria-label="添加回应"]')
          .evaluate((button) => getComputedStyle(button).display),
        'none',
      );
      await mobileMore.click();
      const mobileMenu = shortArticle.getByRole('menu', { name: '更多消息动作', exact: true });
      await mobileMenu.waitFor();
      await assertTouchMenuWithinFlow(mobile, mobileMenu, mobile.locator('.channel-flow'), '整理为工作');
      await mobile.screenshot({ path: path.join(evidenceDirectory, 'u1-mobile-390.png') });
      await mobileMenu.getByRole('menuitem', { name: '发起随手投票', exact: true }).click();
      const channelVoteDraft = shortArticle.getByRole('form', { name: '随手问问草稿', exact: true });
      await channelVoteDraft.waitFor();
      await channelVoteDraft.getByRole('button', { name: '取消', exact: true }).click();

      await mobileMore.click();
      await mobileMenu.waitFor();
      await mobileMenu.getByRole('menuitem', { name: '整理为工作', exact: true }).click();
      await shortArticle.getByRole('region', { name: '工作 · 喵', exact: true }).waitFor();

      await mobileMore.click();
      await mobileMenu.waitFor();
      await mobileMenu.getByRole('menuitem', { name: '用表情回应', exact: true }).click();
      const firstPawChoice = shortArticle.getByRole('button', { name: '用 🐾 回应', exact: true });
      await firstPawChoice.click();
      const firstReactionPending = shortArticle.locator('.reaction-pending');
      await firstReactionPending.waitFor();
      assert.equal(await firstReactionPending.textContent(), '🐾 回应正在保存…');
      assert.equal(await shortArticle.locator('.reaction-bar').getAttribute('aria-busy'), 'true');
      assert.equal(reactionRequestCount, 1);
      assert.ok(firstReactionRoute, 'the first reaction request remains under test control');
      await mobile.screenshot({ path: path.join(evidenceDirectory, 'u1-first-reaction-pending-390.png') });

      await mobileMore.click();
      await shortArticle.getByRole('menuitem', { name: '用表情回应', exact: true }).click();
      const pendingPawChoice = shortArticle.getByRole('button', { name: '用 🐾 回应', exact: true });
      await pendingPawChoice.waitFor();
      assert.equal(await pendingPawChoice.isDisabled(), true);
      await pendingPawChoice.evaluate((button) => button.click());
      assert.equal(reactionRequestCount, 1, 'the pending first reaction cannot submit twice');

      await firstReactionRoute.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'offline' }),
      });
      await shortArticle.getByText('回应未保存，请重试。', { exact: true }).waitFor();
      assert.equal(await shortArticle.locator('.reaction-bar').getAttribute('aria-busy'), 'false');
      assert.equal(await shortArticle.getByRole('toolbar', { name: '选择回应', exact: true }).count(), 0);
      assert.equal(await mobileMore.evaluate((button) => document.activeElement === button), true);
      await mobile.screenshot({ path: path.join(evidenceDirectory, 'u1-first-reaction-error-390.png') });

      await mobileMore.click();
      await shortArticle.getByRole('menuitem', { name: '用表情回应', exact: true }).click();
      await shortArticle.getByRole('button', { name: '用 🐾 回应', exact: true }).click();
      const firstReactionPill = shortArticle.getByRole('button', { name: '🐾 · You', exact: true });
      await firstReactionPill.waitFor();
      assert.equal(reactionRequestCount, 2);
      assert.equal(await firstReactionPill.textContent(), '🐾1');
      assert.equal(await shortArticle.getByText('回应未保存，请重试。', { exact: true }).count(), 0);

      await mobile.reload({ waitUntil: 'networkidle' });
      shortArticle = mobile.locator('article.message').filter({ hasText: short.body });
      await shortArticle.getByRole('button', { name: '🐾 · You', exact: true }).waitFor();
      mobileMore = shortArticle.getByRole('button', { name: '更多消息动作', exact: true });
      await mobileMore.click();
      await shortArticle.getByRole('menuitem', { name: '回复 You', exact: true }).click();
      const topicComposer = mobile.getByRole('textbox', { name: '回复 You 的消息', exact: true });
      await topicComposer.waitFor();
      assert.equal(await topicComposer.evaluate((input) => document.activeElement === input), true);
      const topicFlow = mobile.locator('.topic-flow');
      await topicFlow.evaluate((flow) => {
        flow.scrollTop = flow.scrollHeight;
      });
      const topicReply = mobile.locator('.topic-event').filter({ hasText: topicTail.body });
      const topicReplyMore = topicReply.getByRole('button', { name: '更多消息动作', exact: true });
      await topicReplyMore.click();
      const topicReplyMenu = topicReply.getByRole('menu', { name: '更多消息动作', exact: true });
      await topicReplyMenu.waitFor();
      await assertTouchMenuWithinFlow(mobile, topicReplyMenu, topicFlow, '整理为工作');
      await mobile.screenshot({ path: path.join(evidenceDirectory, 'u1-topic-menu-390.png') });
      await topicReplyMenu.getByRole('menuitem', { name: '发起随手投票', exact: true }).click();
      const topicVoteDraft = topicReply.getByRole('form', { name: '随手问问草稿', exact: true });
      await topicVoteDraft.waitFor();
      await topicVoteDraft.getByRole('button', { name: '取消', exact: true }).click();

      await topicReplyMore.click();
      await topicReplyMenu.waitFor();
      await topicReplyMenu.getByRole('menuitem', { name: '整理为工作', exact: true }).click();
      await topicReply.getByRole('region', { name: `工作 · ${topicTail.body}`, exact: true }).waitFor();

      const topicReaction = topicReply.getByRole('button', { name: '👍 · 吴浪', exact: true });
      const topicReactionBox = await topicReaction.boundingBox();
      assert.ok(topicReactionBox && topicReactionBox.width >= 44 && topicReactionBox.height >= 44);
      await topicReaction.click();
      const topicCombined = topicReply.getByRole('button', { name: '👍 · 吴浪、You', exact: true });
      await topicCombined.waitFor();
      await topicCombined.click();
      await topicReaction.waitFor();
      assert.deepEqual(
        reactionRequests.slice(-2).map(({ eventId, emoji, active }) => ({ eventId, emoji, active })),
        [
          { eventId: topicTail.eventId, emoji: '👍', active: true },
          { eventId: topicTail.eventId, emoji: '👍', active: false },
        ],
      );

      const topicRoot = mobile.locator('.topic-event').filter({ hasText: short.body });
      const topicMore = topicRoot.getByRole('button', { name: '更多消息动作', exact: true });
      await topicMore.click();
      await topicRoot.getByRole('menu', { name: '更多消息动作', exact: true }).waitFor();
      await mobile.keyboard.press('Escape');
      assert.equal(await mobile.locator('.context-panel').count(), 1, 'first Escape closes only the message menu');
      assert.equal(await topicMore.evaluate((button) => document.activeElement === button), true);
      await mobile.screenshot({ path: path.join(evidenceDirectory, 'u1-topic-390.png') });
      await mobile.getByRole('button', { name: '关闭话题', exact: true }).click();
      shortArticle = mobile.locator('article.message').filter({ hasText: short.body });
      await mobile.waitForFunction(
        (eventId) => document.activeElement?.id === `collective-event-${eventId}`,
        short.eventId,
      );

      let reactionArticle = mobile.locator('article.message').filter({ hasText: seeded.first.body });
      const memberReaction = reactionArticle.getByRole('button', { name: '🐾 · 吴浪', exact: true });
      await memberReaction.waitFor();
      const memberReactionBox = await memberReaction.boundingBox();
      assert.ok(memberReactionBox && memberReactionBox.width >= 44 && memberReactionBox.height >= 44);
      const reactionMore = reactionArticle.getByRole('button', { name: '更多消息动作', exact: true });
      await reactionMore.click();
      await reactionArticle.getByRole('menuitem', { name: '用表情回应', exact: true }).click();
      await reactionArticle.getByRole('button', { name: '用 🐾 回应', exact: true }).click();
      const combined = reactionArticle.getByRole('button', { name: '🐾 · 吴浪、You', exact: true });
      await combined.waitFor();
      assert.equal(await combined.textContent(), '🐾2');
      assert.equal(await combined.getAttribute('aria-pressed'), 'true');
      assert.equal(await reactionMore.evaluate((button) => document.activeElement === button), true);
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await mobile.screenshot({ path: path.join(evidenceDirectory, 'u1-reactions-390.png') });

      await mobile.reload({ waitUntil: 'networkidle' });
      reactionArticle = mobile.locator('article.message').filter({ hasText: seeded.first.body });
      const restored = reactionArticle.getByRole('button', { name: '🐾 · 吴浪、You', exact: true });
      await restored.waitFor();
      await restored.click();
      const memberOnly = reactionArticle.getByRole('button', { name: '🐾 · 吴浪', exact: true });
      await memberOnly.waitFor();
      assert.equal(await memberOnly.textContent(), '🐾1');
      assert.equal(await memberOnly.getAttribute('aria-pressed'), 'false');
      assert.deepEqual(
        reactionRequests.slice(-1).map(({ eventId, emoji, active }) => ({ eventId, emoji, active })),
        [{ eventId: seeded.first.eventId, emoji: '🐾', active: false }],
      );
      assert.deepEqual(errors, []);

      const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      await installOwnerSession(desktopContext, server.url, seeded);
      const desktop = await desktopContext.newPage();
      await desktop.goto(server.url, { waitUntil: 'networkidle' });
      await desktop.getByRole('heading', { name: '# 产品方向', exact: true }).waitFor();
      const desktopShort = desktop.locator('article.message').filter({ hasText: short.body });
      const desktopToolbar = desktopShort.getByRole('toolbar', { name: '消息操作', exact: true });
      assert.equal(await desktopToolbar.evaluate((toolbar) => getComputedStyle(toolbar).opacity), '0');
      await desktopShort.hover();
      await desktopToolbar.evaluate(
        (toolbar) =>
          new Promise((resolve) => {
            const waitForVisible = () => {
              if (getComputedStyle(toolbar).opacity === '1') {
                resolve(undefined);
                return;
              }
              requestAnimationFrame(waitForVisible);
            };
            waitForVisible();
          }),
      );
      const desktopMore = desktopShort.getByRole('button', { name: '更多消息动作', exact: true });
      await desktopMore.focus();
      await desktopMore.click();
      await desktopShort.getByRole('menu', { name: '更多消息动作', exact: true }).waitFor();
      await desktop.keyboard.press('Escape');
      assert.equal(await desktopMore.evaluate((button) => document.activeElement === button), true);
      await desktopShort.hover();
      await desktop.screenshot({ path: path.join(evidenceDirectory, 'u1-desktop-1440.png') });
      await desktopMore.click();
      await desktopShort.getByRole('menuitem', { name: '发起随手投票', exact: true }).click();
      await desktopShort.getByLabel('投票问题', { exact: true }).waitFor();
      await desktop.screenshot({ path: path.join(evidenceDirectory, 'u1-poll-draft-1440.png') });
      await desktopContext.close();
      await mobileContext.close();

      console.log(
        JSON.stringify({
          result: 'pass',
          evidence: evidenceDirectory,
          tested: [
            'empty-message-density',
            'touch-more-44px',
            'append-position-touch-menu-poll-work',
            'touch-reaction-44px-exact-set-remove',
            'first-reaction-pending-retry-refresh',
            'topic-reply-focus',
            'exact-source-focus-return',
            'reaction-set-remove-refresh',
            'desktop-hover-focus-escape',
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
