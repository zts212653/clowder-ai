import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { routingContextReadModelV1Schema } from '@cat-cafe/shared';
import { scene } from './f322-members-fixture.mjs';

const out = process.env.MEMBERS_EVIDENCE_DIR ?? '/tmp/f322-member-detail-header';
mkdirSync(out, { recursive: true });
const results = [];
after(() => writeFileSync(path.join(out, 'result.json'), `${JSON.stringify(results, null, 2)}\n`));

test('reads the formal pristine member page without forwarding any mutation', async () => {
  const seed = await scene();
  const browser = seed.context.browser();
  await seed.context.close();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const blocked = [];
  await context.route('**/*', (route) => {
    const request = route.request();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      blocked.push({ method: request.method(), path: new URL(request.url()).pathname });
      return route.fulfill({ status: 204, body: '' });
    }
    return route.continue();
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => localStorage.setItem('cat-cafe:shell-language', 'zh'));
    await page.goto('http://localhost:3003/settings?s=members&cat=opus55&shell=v2', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.locator('#member-field-panel').waitFor({ timeout: 45000 });
    const top = page.locator('[data-testid="member-settings-page"] > div').first();
    await top.screenshot({ path: path.join(out, 'before-formal-top-1440.png') });
    await page.screenshot({ path: path.join(out, 'before-formal-page-1440.png') });
    const saveBars = await page.getByTestId('member-save-bar').count();
    assert.equal(saveBars, 0, 'The formal pristine page reproduces the missing save bar');
    results.push({
      formalReadOnly: true,
      width: 1440,
      saveBars,
      summary: await page.locator('.member-detail-summary').innerText(),
      buildRevision: await page.locator('html').getAttribute('data-cat-cafe-build-revision'),
      blocked,
      forwardedMutations: 0,
    });
  } finally {
    await context.close();
  }
});

for (const [width, language] of [
  [1440, 'zh'],
  [1440, 'en'],
  [390, 'en'],
]) {
  test(`global language, latest work and visible pristine/dirty save bar (${width}/${language})`, async () => {
    const now = Date.now();
    const { context, page, state } = await scene(width, false, false, false);
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route('**/api/cats/native-runtimes*', (route) =>
      route.fulfill({
        json: { runtimes: [] },
      }),
    );
    await page.route('**/api/agent-providers', (route) => route.fulfill({ json: { libraries: [] } }));
    try {
      const old = new Date(2026, 9, 11, 21, 9).getTime();
      const success = now - 120000;
      const expectedTime = await page.evaluate(
        (at) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        success,
      );
      const signal = (id, source, at) => ({
        v: 1,
        eventId: id,
        commandId: id,
        ownerId: 'fixture-owner',
        subjectRef: { type: 'cat', catId: 'fixture-a' },
        source,
        reasonCode: source === 'dispatch_success' ? 'dispatch_success_probe' : 'routing_signal_recovered',
        eventType: 'recovered',
        state: 'available',
        observedAt: at,
        evidenceRef: `fixture:${id}`,
        closesSignalIds: source === 'dispatch_success' ? [] : ['retired-assertion'],
        ...(source === 'dispatch_success' ? { probeStartedAt: at - 1000 } : {}),
      });
      state.routingData = {
        v: 1,
        ownerId: 'fixture-owner',
        observedAt: now,
        catalogRevision: 'fixture',
        preferenceRevisions: [],
        signalEvents: [signal('health', 'health_probe', old), signal('work', 'dispatch_success', success)],
        resolution: {
          state: 'fresh',
          inputRevisionRef: 'fixture',
          sourceRefs: { signalEventIds: ['health'], preferenceRevisionIds: [], dossierRevisions: [] },
          snapshot: {
            v: 1,
            ownerId: 'fixture-owner',
            observedAt: now,
            catalogRevision: 'fixture',
            candidates: [
              {
                binding: { v: 1, catId: 'fixture-a', providerId: 'anthropic', provenQuotaPools: [] },
                profile: { state: 'absent' },
                availability: 'available',
                freshness: 'fresh',
                reasons: [{ code: 'routing_signal_recovered', summary: 'Recovered', sourceRefs: ['health'] }],
                matchedPreferences: [],
                effect: 'eligible',
              },
            ],
          },
        },
      };
      routingContextReadModelV1Schema.parse(state.routingData);
      Object.assign(state.cats[0], {
        displayName: '隔离成员',
        roleDescription: '用于核对成员详情与保存条的隔离样本，不读取或改写真实成员。',
      });
      await page.goto('https://f322-members.test/settings?s=members&cat=fixture-a&shell=v2&lang=zh');
      await page.evaluate((value) => window.f322MemberFixture.writeLanguage(value), language);
      const summary = page.locator('.member-detail-summary');
      await page.locator('#member-field-panel').waitFor();
      await page.waitForFunction(() =>
        /顺利|finished successfully/.test(document.querySelector('.member-detail-summary')?.textContent ?? ''),
      );
      writeFileSync(
        path.join(out, `debug-dom-${language}-${width}.json`),
        JSON.stringify(
          await page
            .evaluate(() => ({
              url: location.href,
              text: document.body.innerText,
              html: document.getElementById('root')?.innerHTML,
            }))
            .then((dom) => ({ ...dom, pageErrors })),
          null,
          2,
        ),
      );
      await page.screenshot({ path: path.join(out, `debug-initial-${language}-${width}.png`) });
      await page
        .getByTestId('member-settings-page')
        .getByRole('button', { name: language === 'zh' ? '← 成员与运行时' : '← Members & runtime', exact: true })
        .waitFor({ timeout: 10000 });
      assert.ok((await summary.innerText()).includes(expectedTime));
      assert.doesNotMatch(await summary.innerText(), /已恢复|Recovered|2026/);
      assert.equal(await page.getByRole('button', { name: /^(English|中文)$/ }).count(), 0);
      const bar = page.getByTestId('member-save-bar');
      await bar.waitFor();
      const geometry = await bar.boundingBox();
      assert.ok(geometry && geometry.y >= 0 && geometry.y + geometry.height <= 901, JSON.stringify(geometry));
      const top = page.locator('[data-testid="member-settings-page"] > div').first();
      await top.screenshot({ path: path.join(out, `after-top-${language}-${width}.png`) });
      await page.screenshot({ path: path.join(out, `after-page-${language}-${width}.png`) });
      const writes = () =>
        state.writes.filter(
          (item) =>
            ['PATCH', 'PUT', 'DELETE'].includes(item.method) || (item.method === 'POST' && item.path === '/api/cats'),
        );
      const before = writes().length;
      await bar.getByRole('button', { name: language === 'zh' ? '保存' : 'Save', exact: true }).click();
      assert.match(await bar.innerText(), language === 'zh' ? /没有要保存的修改/ : /There are no changes to save/);
      assert.equal(writes().length, before);
      await page
        .getByRole('button', { name: language === 'zh' ? '身份与职责' : 'Identity & role', exact: true })
        .click();
      await page.getByLabel(language === 'zh' ? '昵称' : 'Nickname', { exact: true }).fill('Changed nickname');
      await bar
        .getByRole('button', { name: language === 'zh' ? '放弃修改' : 'Discard changes', exact: true })
        .waitFor();
      await page.locator('#member-field-panel').evaluate((node) => node.scrollIntoView({ block: 'end' }));
      const scrolled = await bar.boundingBox();
      assert.ok(scrolled && scrolled.y >= 0 && scrolled.y + scrolled.height <= 901, JSON.stringify(scrolled));
      await bar.getByRole('button', { name: language === 'zh' ? '放弃修改' : 'Discard changes', exact: true }).click();
      assert.equal(writes().length, before);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(pageErrors, []);
      results.push({
        width,
        language,
        isolatedFixture: true,
        latestWorkTime: expectedTime,
        geometry,
        scrolled,
        globalLanguage: true,
        localLanguageSwitch: false,
        pristineSaveWrites: 0,
        discardWrites: 0,
        pageErrors,
      });
    } catch (error) {
      const dom = await page.evaluate(() => ({ text: document.body.innerText, html: document.body.innerHTML }));
      writeFileSync(
        path.join(out, `debug-terminal-${language}-${width}.json`),
        JSON.stringify({ ...dom, pageErrors }, null, 2),
      );
      throw error;
    } finally {
      await context.close();
    }
  });
}
