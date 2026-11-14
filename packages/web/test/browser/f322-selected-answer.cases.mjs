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
  async function open(kind = 'verified', mobile = false) {
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
        if (url.pathname === '/api/evidence/navigation-source')
          body = url.searchParams.has('contextCount') ? data.contexts[kind] : data.navigation[kind];
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
        body: `<!doctype html><html ${mobile ? 'data-theme="dark" class="dark"' : ''}><meta charset="utf-8">${productionCss.map((href) => `<link rel="stylesheet" href="${href}">`).join('')}<link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script></html>`,
      });
    });
    await page.goto(origin + '?proofAnswer=1');
    await page.locator('[data-message-search-answer]').waitFor();
    if (kind !== 'legacy') await page.getByText(/由 小太阳 选出/).waitFor();
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
        assert.match(text, /由 小太阳 选出 1 处来源/);
        assert.match(text, /co-creator.*引用了材料/s);
        assert.match(text, /只在测试全部通过后/);
        assert.match(text, /co-creator 当条批注：.*还不直接当合同/s);
        assert.match(text, /小太阳 选用理由：co-creator已拍板立即下线判官/);
        assert.equal(await card.locator('mark').innerText(), '下线判官');
        assert.equal(await card.locator('[aria-label="定下来的"]').count(), 0);
        assert.doesNotMatch(text, /FORGED AUTHOR|本次结果中最早|已证实/);
        if (kind === 'verified') {
          assert.match(text, /引自 烁烁 的消息/);
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
        await card.getByRole('button', { name: '在查找里看全部 ›' }).click();
        const results = page.getByRole('region', { name: '消息检索结果' });
        await results.getByText('猫选顺序', { exact: true }).waitFor();
        const row = results.locator('[data-message-search-result]');
        assert.match(await row.innerText(), /选用理由/);
        await row.getByRole('button', { name: '展开前后文：第1处', exact: true }).click();
        await row.getByText(/同条消息（正文、引文与批注）/).waitFor();
        const contexts = state.requests.filter((url) => url.includes('contextCount=')).length;
        const reads = state.requests.filter((url) => url.startsWith('/api/evidence/answer')).length;
        state.withdrawn = true;
        await row.getByRole('button', { name: '引用到聊天', exact: true }).click();
        await row.getByRole('alert').waitFor();
        assert.ok(
          state.requests.filter((url) => url.startsWith('/api/evidence/answer')).length > reads,
          'Find re-reads the real original binding',
        );
        assert.equal(
          state.requests.filter((url) => url.includes('contextCount=')).length,
          contexts,
          'revoked provenance stops before ordinary source quoting',
        );
        assert.match(await row.getByRole('alert').innerText(), /来源卡已更新/);
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
}
