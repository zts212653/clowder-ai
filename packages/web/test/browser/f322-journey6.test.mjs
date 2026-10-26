import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { buildChatProof, webRoot } from './fixtures/f322-chat-real-page-build.mjs';
import { CURRENT_THREAD, DRAFT } from './fixtures/f322-chat-real-page-data.mjs';
import { data, openJourneyPage, payloadSha256 } from './fixtures/f322-journey6-api.mjs';

// Optional private capture is produced by the real compiled search/admission service with
// an explicit deterministic qualifier. This test never forwards a search or a provider call.
const payloadFile = process.env.F322_JOURNEY6_PAYLOAD;
const evidence = process.env.F322_JOURNEY6_EVIDENCE || path.resolve(webRoot, '../../.cat-cafe/tmp/journey6');
let built, browser;
before(async () => {
  await fs.mkdir(evidence, { recursive: true });
  built = await buildChatProof('f322-journey6.tsx');
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});

const open = (...args) => openJourneyPage(browser, built, ...args);
async function search(page) {
  await page.getByRole('button', { name: '查找消息', exact: true }).click();
  await page.getByRole('button', { name: '全局', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索消息' }).fill(data.response.query);
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('region', { name: '定下来的', exact: true }).waitFor();
}

test('Journey 6 reuses one modal, original-source context, J5 return and the existing draft composer', async () => {
  const proof = await open();
  const { page } = proof;
  const samples = [];
  try {
    const before = await page
      .locator('[data-chat-container]')
      .evaluate((n) => ({ top: n.scrollTop, max: n.scrollHeight - n.clientHeight }));
    await search(page);
    assert.equal(await page.locator('[data-message-search-result]').count(), data.response.results.length);
    assert.ok(await page.getByText('提议 · 没采用', { exact: true }).count());
    const summary = page.getByRole('region', { name: '定下来的', exact: true });
    assert.equal(await summary.getByRole('button', { name: '引用到聊天', exact: true }).count(), 1);
    assert.ok(!(await summary.innerText()).includes('托付邀请'));
    assert.ok((await page.locator('[data-message-search-result]').first().innerText()).includes('这条决定的出处'));
    await page.screenshot({ path: path.join(evidence, '01-results-1440.png') });
    const row = page.locator('[data-message-search-result]').nth(1);
    await row.getByRole('button', { name: '展开前后文：第2处' }).click();
    await row.locator('[data-message-search-context]').waitFor();
    await row.getByText('正在读取原文…').waitFor({ state: 'detached' });
    assert.ok(
      (await row.locator('[data-message-search-context]').innerText()).includes(
        data.records.find((r) => r.id === data.response.results[1].messageId).content.split('\n')[0],
      ),
    );
    const opening = await row
      .locator('[data-message-search-context] [data-message-search-focus]')
      .first()
      .evaluate((mark) => {
        const text = mark.getBoundingClientRect();
        const viewport = mark.closest('[data-message-search-scroll]').getBoundingClientRect();
        const chat = document.querySelector('[data-chat-container]');
        return {
          top: text.top,
          bottom: text.bottom,
          viewport: { top: viewport.top, bottom: viewport.bottom },
          chatTop: chat.scrollTop,
          paragraph: mark.closest('[data-source-paragraph]').textContent,
        };
      });
    assert.ok(
      opening.top >= opening.viewport.top && opening.bottom <= opening.viewport.bottom,
      JSON.stringify(opening),
    );
    assert.ok(Math.abs(opening.chatTop - before.top) <= 1, 'expanding only scrolls the find popover');
    assert.ok(opening.paragraph.includes('侧栏对话标题'), JSON.stringify(opening));
    await page.screenshot({ path: path.join(evidence, '02-expanded-1440.png') });
    await row.getByRole('button', { name: /^去原处：/ }).click();
    for (const [index, action] of [
      [1, null],
      [2, '下一处结果'],
      [1, '上一处结果'],
    ]) {
      if (action) await page.getByRole('button', { name: action, exact: true }).click();
      await page.waitForFunction((index) => {
        const id = localStorage.getItem('cat-cafe:message-reading-active:v1');
        const trip = id && JSON.parse(localStorage.getItem(`cat-cafe:message-reading-session:${id}`))?.session?.trip;
        return trip?.status === 'ready' && trip.settledIndex === index;
      }, index);
      const id = data.response.results[index].messageId;
      const geometry = await page
        .locator(`[data-message-id="${id}"]`)
        .first()
        .evaluate((node) => {
          const target = node.getBoundingClientRect(),
            viewport = node.closest('[data-chat-container]').getBoundingClientRect();
          const toolbar = document.querySelector('[aria-label="浏览本次检索结果"]').getBoundingClientRect();
          return {
            top: target.top,
            bottom: target.bottom,
            height: target.height,
            viewport: { top: viewport.top, bottom: viewport.bottom, height: viewport.height },
            toolbarBottom: toolbar.bottom,
          };
        });
      assert.ok(geometry.toolbarBottom <= geometry.viewport.top, JSON.stringify(geometry));
      assert.ok(geometry.top >= geometry.viewport.top - 1, JSON.stringify(geometry));
      if (geometry.height <= geometry.viewport.height - 8)
        assert.ok(geometry.bottom <= geometry.viewport.bottom + 1, JSON.stringify(geometry));
      samples.push(geometry);
    }
    await page.getByRole('button', { name: '‹ 回到「继续刚才的设计」', exact: true }).click();
    await page.getByRole('navigation', { name: '浏览本次检索结果' }).waitFor({ state: 'detached' });
    assert.ok(page.url().includes(CURRENT_THREAD));
    const returned = await page
      .locator('[data-chat-container]')
      .evaluate((n) => ({ top: n.scrollTop, max: n.scrollHeight - n.clientHeight }));
    assert.ok(Math.abs(returned.top - before.top) <= 1, JSON.stringify({ before, returned }));
    assert.equal(await page.locator('textarea').inputValue(), DRAFT);
    await page.screenshot({ path: path.join(evidence, '03-returned-1440.png') });
    await search(page);
    await page
      .getByRole('region', { name: '定下来的', exact: true })
      .getByRole('button', { name: '引用到聊天', exact: true })
      .click();
    await page.getByRole('button', { name: '已引用', exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭消息搜索', exact: true }).click();
    assert.equal(await page.locator('textarea').inputValue(), DRAFT);
    assert.ok(await page.getByText(/You · .*已定/).count());
    await page.screenshot({ path: path.join(evidence, '04-quoted-composer-1440.png') });
    assert.ok(
      proof.requests.some((r) => r.path === '/api/messages' && r.search.includes('before=')),
      'cold source loads older history through the existing owner',
    );
    assert.equal(proof.api.sent.length, 0);
    assert.deepEqual(proof.errors, []);
    assert.deepEqual(proof.unexpected, []);
    await fs.writeFile(
      path.join(evidence, 'result.json'),
      JSON.stringify(
        {
          kind: payloadFile
            ? 'captured-original-source controlled UI replay'
            : 'deterministic production-component fixture',
          payloadSha256,
          forwardedSearches: 0,
          nativeCalls: 0,
          productionWrites: 0,
          samples,
          opening,
          before,
          returned,
          requests: proof.requests,
          errors: proof.errors,
          unexpected: proof.unexpected,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await page.screenshot({ path: path.join(evidence, 'failure.png') });
    await fs.writeFile(
      path.join(evidence, 'failure.json'),
      JSON.stringify(
        {
          url: page.url(),
          requests: proof.requests,
          errors: proof.errors,
          unexpected: proof.unexpected,
          navigation: proof.navigation,
          state: await page.evaluate(() => ({
            text: document.body.innerText.slice(-3000),
            storage: Object.fromEntries(
              Object.keys(localStorage)
                .filter((k) => k.includes('message-reading'))
                .map((k) => [k, localStorage.getItem(k)]),
            ),
          })),
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await proof.context.close();
  }
});

test('classic keeps its original result controls; narrow dark v2 keeps the new actions reachable', async () => {
  for (const [width, presentation, dark] of [
    [1440, 'classic', false],
    [390, 'v2', true],
  ]) {
    const proof = await open(width, presentation, dark);
    try {
      await proof.page.getByRole('button', { name: '查找消息', exact: true }).click();
      await proof.page.getByRole('textbox', { name: '搜索消息' }).fill(data.response.query);
      await proof.page.getByRole('button', { name: '搜索', exact: true }).click();
      await proof.page.locator('[data-message-search-result]').first().waitFor();
      assert.equal(
        await proof.page
          .locator('[data-message-search-result]')
          .getByRole('button', { name: '引用到聊天', exact: true })
          .count(),
        presentation === 'v2' ? data.response.results.length : 0,
      );
      assert.equal(
        await proof.page
          .getByRole('region', { name: '定下来的', exact: true })
          .getByRole('button', { name: '引用到聊天', exact: true })
          .count(),
        presentation === 'v2' ? 1 : 0,
      );
      const dialog = proof.page.getByRole('dialog', { name: '查找消息' });
      const box = await dialog.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width);
      await proof.page.getByRole('textbox', { name: '搜索消息' }).press('Escape');
      await dialog.waitFor({ state: 'detached' });
      assert.deepEqual(proof.errors, []);
      assert.deepEqual(proof.unexpected, []);
    } finally {
      await proof.context.close();
    }
  }
});
