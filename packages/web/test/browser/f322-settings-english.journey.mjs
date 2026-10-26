import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { scene } from './f322-members-fixture.mjs';

const out = process.env.SETTINGS_EVIDENCE_DIR ?? '/tmp/f322-settings-english';
mkdirSync(out, { recursive: true });
const results = [];
after(() => writeFileSync(`${out}/result.json`, `${JSON.stringify(results, null, 2)}\n`));

for (const width of [1440, 390]) {
  test(`English settings chrome and canonical member title at ${width}`, async () => {
    const { page, context, state } = await scene(width);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/cats/native-runtimes*', (route) => route.fulfill({ json: { runtimes: [] } }));
    await page.route('**/api/agent-providers', (route) => route.fulfill({ json: { libraries: [] } }));
    Object.assign(state.cats[0], {
      displayName: '成员页验收样本',
      roleDescription: '仅用于核对英文设置菜单；成员自填内容保留原文。',
    });
    try {
      await page.goto('https://f322-members.test/settings?s=members&cat=fixture-a&shell=v2&lang=zh');
      await page.evaluate(() => window.f322MemberFixture.writeLanguage('en'));
      await page.locator('#member-field-panel').waitFor();
      await page.getByRole('button', { name: '← Members & runtime', exact: true }).waitFor();
      assert.equal(await page.getByTestId('settings-tab-members').innerText(), 'Members & runtime');
      assert.equal(await page.getByTestId('settings-tab-concierge').innerText(), 'Cat Ball');
      assert.equal(await page.getByTestId('settings-team-workspace').innerText(), 'Member capabilities & routing');
      assert.equal(await page.getByRole('tablist').getAttribute('aria-label'), 'Cat team sections');
      const navigation = page.locator('button[aria-controls="settings-mobile-navigation"]');
      assert.equal(await navigation.innerText(), 'Settings navigation');
      if (width < 768) {
        await navigation.click();
        assert.equal(await navigation.getAttribute('aria-expanded'), 'true');
        assert.doesNotMatch(await page.locator('#settings-mobile-navigation').innerText(), /\p{Script=Han}/u);
        await navigation.click();
      }
      assert.doesNotMatch(await page.getByRole('tablist').innerText(), /\p{Script=Han}/u);
      assert.equal(await page.getByTestId('settings-tab-members').getAttribute('aria-selected'), 'true');
      assert.equal(
        await page
          .getByRole('button', { name: 'Pin "Member capabilities & routing" to the narrow rail', exact: true })
          .count(),
        1,
      );
      const chrome = await page.getByTestId('settings-team-workspace').boundingBox();
      assert.ok(chrome && chrome.x >= 0 && chrome.x + chrome.width <= width + 1);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      assert.equal(
        state.writes.filter(
          (item) =>
            ['PATCH', 'PUT', 'DELETE'].includes(item.method) || (item.method === 'POST' && item.path === '/api/cats'),
        ).length,
        0,
      );
      await page.screenshot({ path: `${out}/after-en-${width}.png` });
      results.push({
        width,
        language: 'en',
        globalLanguageDespiteZhQuery: true,
        mobileNavigationToggle: width < 768,
        canonicalTitle: 'Members & runtime',
        noChineseMenuText: true,
        selectedTabPreserved: true,
        configurationWrites: 0,
        pageErrors: errors,
        workspaceButton: chrome,
      });
    } finally {
      await context.close();
    }
  });
}
