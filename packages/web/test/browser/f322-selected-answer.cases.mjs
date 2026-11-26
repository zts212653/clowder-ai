import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { before, test } from 'node:test';
import '../../../api/test/helpers/setup-cat-registry.js';
import { selectedAnswerBrowserFixture } from '../../../api/test/helpers/message-selected-browser-fixture.js';

/** Extend the admitted message-reading unit; reuse its browser and production bundle. */
export function registerSelectedAnswerCases({ assets, web, root, origin }) {
  const evidence = path.join(root, '.cat-cafe/tmp/selected-answer-browser');
  let data;
  before(async () => {
    data = await selectedAnswerBrowserFixture();
    await fs.mkdir(evidence, { recursive: true });
    await fs.writeFile(path.join(evidence, 'actual-host-fixture.json'), JSON.stringify(data, null, 2));
  });
  async function open(kind = 'verified', mobile = false, dark = mobile) {
    const { browser, script, css, productionCss } = assets();
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1440, height: mobile ? 844 : 900 } });
    const state = { withdrawn: false, requests: [], errors: [] };
    await page.addInitScript(() => localStorage.setItem('cat-cafe:shell-presentation', 'v2'));
    page.on('pageerror', (error) => state.errors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, origin, 'controlled fixtures never contact runtime or a provider');
      if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (url.pathname === '/proof.css') return route.fulfill({ contentType: 'text/css', body: css });
      if (productionCss.includes(url.pathname))
        return route.fulfill({
          contentType: 'text/css',
          body: await fs.readFile(path.join(web, 'public', url.pathname.slice(1)), 'utf8'),
        });
      if (url.pathname.startsWith('/api/')) {
        state.requests.push(url.pathname + url.search);
        let body = { cats: [], tasks: [], queue: [], activeInvocations: [] };
        if (url.pathname === '/api/cats')
          body = {
            cats: ['codex61-sol', 'gemini-argon'].map((id) => ({
              id,
              displayName: id,
              nickname: id === 'codex61-sol' ? '小太阳' : '烁烁',
              breedId: 'maine-coon',
              avatar: '/avatars/codex.png',
              mentionPatterns: ['@' + id],
              carrier: 'cli',
              clientId: 'openai',
              defaultModel: 'gpt-6.1-sol',
              color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
            })),
          };
        if (url.pathname === '/api/messages')
          body = {
            messages:
              url.searchParams.get('threadId') === 'sources' ? (data.sources[kind] ?? []) : [data.records[kind]],
            hasMore: false,
          };
        if (url.pathname === '/api/evidence/answer') {
          assert.equal(url.searchParams.get('messageId'), data.records[kind].id);
          assert.equal(url.searchParams.get('blockId'), data.records[kind].extra.messageSearchAnswer.blockId);
          body = state.withdrawn ? data.views.withdrawn : data.views[kind];
        }
        if (url.pathname === '/api/evidence/navigation-source') {
          const key = `${kind}:${url.searchParams.get('messageId')}`;
          body = !url.searchParams.has('messageId')
            ? data.navigation.origin
            : url.searchParams.has('contextCount')
              ? (data.contexts[key] ?? data.contexts[kind])
              : (data.navigation[key] ?? data.navigation[kind]);
        }
        if (url.pathname === '/api/evidence/search')
          assert.fail('opening, restoring or acting on a selected card must not start retrieval');
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      }
      if (url.pathname === '/avatars/codex.png')
        return route.fulfill({
          contentType: 'image/png',
          body: await fs.readFile(path.join(web, 'public/avatars/codex.png')),
        });
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html ${dark ? 'data-theme="dark" class="dark"' : ''}><meta charset="utf-8">${productionCss.map((href) => `<link rel="stylesheet" href="${href}">`).join('')}<link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script></html>`,
      });
    });
    await page.goto(origin + '?proofAnswer=1');
    await page.locator('[data-message-search-answer]').waitFor();
    await page.locator('[data-message-search-answer] [data-message-search-result]').first().waitFor();
    return { page, state };
  }

  for (const [kind, mobile] of [
    ['verified', false],
    ['unverified', true],
  ])
    test(`real Chat ${kind} selected card preserves conditions, provenance and cat judgment at ${mobile ? '390 dark' : '1440 light'}`, async () => {
      const { page, state } = await open(kind, mobile);
      try {
        const card = page.locator('[data-message-search-answer]');
        const text = await card.innerText();
        assert.doesNotMatch(text, /由 小太阳 选出|是否支持结论|选用理由|在查找里看全部/);
        assert.match(text, /co-creator/);
        assert.match(text, /只在测试全部通过后/);
        assert.match(text, /co-creator 当条批注：.*还不直接当合同/s);
        assert.equal(await card.locator('mark').innerText(), '下线判官');
        assert.equal(await card.locator('[aria-label="定下来的"]').count(), 0);
        assert.doesNotMatch(text, /FORGED AUTHOR|本次结果中最早|已证实/);
        if (kind === 'verified') {
          assert.match(text, /引自 烁烁（/);
          assert.match(text, /历史备选（未采用）/);
        } else assert.match(text, /未核实原出处作者/);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        assert.equal(overflow, false);
        await page.screenshot({
          path: path.join(evidence, `selected-${kind}-${mobile ? '390-dark' : '1440-light'}.png`),
        });
        await card.getByRole('button', { name: '引用到聊天', exact: true }).click();
        const composerQuote = page.getByLabel('聊天输入的引用');
        await composerQuote.waitFor();
        const quoted = await composerQuote.innerText();
        assert.match(quoted, /结构化摘录/);
        assert.match(quoted, /只在测试全部通过后/);
        assert.match(quoted, /co-creator 当条批注/);
        if (kind === 'verified') assert.match(quoted, /引自 烁烁/);
        else assert.match(quoted, /未核实原出处作者/);
        assert.equal(
          state.requests.some((url) => url.includes('contextCount=')),
          false,
          'quoting the bound structural proof never fetches a flattened source afterward',
        );
        await page.screenshot({ path: path.join(evidence, `selected-quoted-${kind}.png`) });
        await card.getByRole('button', { name: '展开前后文：第1处', exact: true }).click();
        await card.getByText(/同条消息（正文、引文与批注）/).waitFor();
        await card.getByRole('button', { name: '收起前后文：第1处', exact: true }).click();
        await card.getByRole('button', { name: /去原处：.*第1处/ }).click();
        await page.waitForURL('**/thread/sources');
        await page.locator('[data-reading-trip-status="ready"]').waitFor();
        await page.getByRole('button', { name: /^(?:回到刚才|‹ 回到「)/ }).click();
        try {
          await page.locator('[data-reading-trip-status="completed"]').waitFor();
        } catch (error) {
          await fs.writeFile(
            path.join(evidence, `return-failure-${kind}.json`),
            JSON.stringify(
              await page.evaluate(() => ({
                url: location.href,
                body: document.body.innerText,
                reading: document.querySelector('[data-reading-trip-status]')?.getAttribute('data-reading-trip-status'),
                storage: Object.fromEntries(
                  Object.entries(localStorage).filter(([key]) => /message-reading|thread-scroll/u.test(key)),
                ),
              })),
              null,
              2,
            ),
          );
          await page.screenshot({ path: path.join(evidence, `return-failure-${kind}.png`) });
          throw error;
        }
        await card.waitFor();
        const contexts = state.requests.filter((url) => url.includes('contextCount=')).length;
        const reads = state.requests.filter((url) => url.startsWith('/api/evidence/answer')).length;
        state.withdrawn = true;
        await card.getByRole('button', { name: /去原处：.*第1处/ }).click();
        await page.getByText('来源卡暂不可用，请查看原消息或稍后重试。', { exact: true }).waitFor();
        assert.ok(
          state.requests.filter((url) => url.startsWith('/api/evidence/answer')).length > reads,
          'navigation re-reads the real original binding after returning to the card',
        );
        assert.equal(
          state.requests.filter((url) => url.includes('contextCount=')).length,
          contexts,
          'revoked provenance stops before ordinary source quoting',
        );
        await page.screenshot({
          path: path.join(evidence, `selected-withdrawn-${mobile ? '390-dark' : '1440-light'}.png`),
        });
        assert.deepEqual(state.errors, []);
      } finally {
        await page.close();
      }
    });

  test('a historical supported card still renders its original title and status without selected-answer labels', async () => {
    const { page, state } = await open('legacy');
    try {
      const card = page.locator('[data-message-search-answer]');
      assert.match(await card.innerText(), /「piano」的查找来源/);
      assert.doesNotMatch(await card.innerText(), /选用理由|由 .*选出|猫选顺序/);
      assert.deepEqual(state.errors, []);
      await page.screenshot({ path: path.join(evidence, 'legacy-card-1440.png') });
    } finally {
      await page.close();
    }
  });

  test('narrow source cards keep names, time and actions separate inside a wide desktop host', async () => {
    const { page, state } = await open('multiple', false, true);
    try {
      const card = page.locator('[data-message-search-answer]');
      const overlap = (a, b) =>
        Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
        Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      for (const width of [262, 380]) {
        await card.evaluate((element, width) => {
          element.style.width = `${width}px`;
        }, width);
        const rows = await card.evaluate((element) =>
          [...element.querySelectorAll('[data-message-search-result]')].map((row) => ({
            speaker: row.querySelector('[data-testid="cat-nameplate"]').getBoundingClientRect().toJSON(),
            time: row.querySelector('time').getBoundingClientRect().toJSON(),
            quote: row.querySelector('button[aria-label="引用到聊天"]').getBoundingClientRect().toJSON(),
            navigate: row.querySelector('button[aria-label^="去原处："]').getBoundingClientRect().toJSON(),
          })),
        );
        for (const row of rows) {
          assert.equal(overlap(row.speaker, row.quote), 0, JSON.stringify(row));
          assert.equal(overlap(row.time, row.quote), 0, JSON.stringify(row));
          assert.equal(overlap(row.time, row.navigate), 0, JSON.stringify(row));
          assert(
            row.time.top >= row.speaker.bottom,
            'narrow cards put provenance on the second line even at desktop viewport width',
          );
        }
        assert.doesNotMatch(await card.innerText(), /选用理由/);
        await page.screenshot({ path: path.join(evidence, `narrow-card-${width}-desktop-dark.png`) });
      }
      await card.getByRole('button', { name: '展开前后文：第1处', exact: true }).click();
      await card
        .locator('[data-message-search-context]')
        .getByText(/选材说明（非原文）/)
        .waitFor();
      assert.deepEqual(state.errors, []);
    } finally {
      await page.close();
    }
  });

  for (const dark of [false, true])
    test(`focused single and multiple source cards follow the compact design in ${dark ? 'dark' : 'light'}`, async () => {
      for (const kind of ['compact', 'multiple']) {
        const { page, state } = await open(kind, false, dark);
        try {
          const card = page.locator('[data-message-search-answer]');
          const text = await card.innerText();
          assert.doesNotMatch(text, /无关的前段|无关的后段|工具过程|是否支持结论|在查找里看全部|\*\*|`/);
          assert.match(text, /未通过测试时，不要提前发布/);
          assert.equal(await card.locator('code').first().innerText(), '#7166');
          assert.equal(await card.locator('strong').first().innerText(), 'main');
          assert.match(
            await card
              .locator('mark')
              .allTextContents()
              .then((values) => values.join('')),
            /PR #7166 已合入 main/,
          );
          assert.equal(await card.locator('[data-message-search-result]').count(), kind === 'compact' ? 1 : 2);
          if (kind === 'compact') assert.doesNotMatch(text, /选用理由/);
          const geometry = await card.evaluate((element) => {
            const row = element.querySelector('[data-message-search-result]');
            const quote = element.querySelector('.markdown-content');
            const header = row.firstElementChild;
            const box = header.getBoundingClientRect();
            const actions = [...header.querySelectorAll('button')].map((button) => {
              const rect = button.getBoundingClientRect();
              return { top: rect.top, bottom: rect.bottom, right: rect.right };
            });
            return {
              width: element.getBoundingClientRect().width,
              height: element.getBoundingClientRect().height,
              quoteHeight: quote.getBoundingClientRect().height,
              lineHeight: parseFloat(getComputedStyle(quote).lineHeight),
              headerTop: box.top,
              headerBottom: box.bottom,
              right: element.getBoundingClientRect().right,
              actions,
            };
          });
          assert.equal(
            geometry.width,
            620,
            'inline-size containment must preserve the wide card in the 720px Chat host',
          );
          assert(geometry.quoteHeight <= geometry.lineHeight * 3 + 1);
          assert(
            geometry.actions.every(
              (button) =>
                button.top >= geometry.headerTop &&
                button.bottom <= geometry.headerBottom &&
                button.right <= geometry.right,
            ),
          );
          if (kind === 'compact')
            assert(geometry.height <= 130, `single card should stay compact: ${JSON.stringify(geometry)}`);
          await fs.writeFile(
            path.join(evidence, `${kind}-${dark ? 'dark' : 'light'}-geometry.json`),
            JSON.stringify(geometry, null, 2),
          );
          await page.screenshot({ path: path.join(evidence, `${kind}-${dark ? 'dark' : 'light'}.png`) });
          if (kind === 'compact') {
            await card.getByRole('button', { name: '展开前后文：第1处', exact: true }).click();
            const drawer = card.locator('[data-message-search-context]');
            await drawer.getByText(/无关的前段/).waitFor();
            assert.match(await drawer.innerText(), /后续回复/);
            assert.equal(await drawer.locator('code').first().innerText(), '#7166');
            const drawerSize = await drawer.evaluate((element) => ({
              height: element.clientHeight,
              scrollHeight: element.scrollHeight,
              overflow: getComputedStyle(element).overflowY,
            }));
            assert(
              drawerSize.height <= 256 && drawerSize.scrollHeight > drawerSize.height && drawerSize.overflow === 'auto',
            );
            assert.doesNotMatch(await drawer.innerText(), /归属以上方分栏为准/);
            await page.screenshot({ path: path.join(evidence, `compact-expanded-${dark ? 'dark' : 'light'}.png`) });
            await card.getByRole('button', { name: '收起前后文：第1处', exact: true }).click();
            assert.equal(await card.locator('[data-message-search-context]').count(), 0);
          }
          assert.deepEqual(state.errors, []);
        } finally {
          await page.close();
        }
      }
    });
}
