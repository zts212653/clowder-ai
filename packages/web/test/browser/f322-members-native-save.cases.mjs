import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scene, screenshots } from './f322-members-fixture.mjs';

for (const [language, width, offset] of [
  ['zh', 1024, 0],
  ['en', 1024, 0],
  ['zh', 390, 0],
  ['en', 390, 0],
  ['en', 1024, 500],
])
  test(`Native connection Save validates, persists and reads back (${language}/${width}/${offset})`, async () => {
    const { nativeMemberProducer } = await import('./f322-members-native-producer.fixture.mjs');
    const producer = await nativeMemberProducer();
    const { context, page, state } = await scene(width, language === 'en', false, false, {
      catsProducer: producer,
      accounts: [
        {
          id: 'gemini',
          clientId: 'google',
          displayName: 'Gemini (OAuth)',
          authType: 'oauth',
          kind: 'builtin',
          builtin: true,
          models: [],
        },
      ],
    });
    const key = `${language}-${width}-${offset}`;
    const screenshot = async (stage) => {
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `native-${key}-${stage}.png`) });
    };
    const observe = (button) => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const host = document.querySelector('[data-trajectory-origin-scroll]').getBoundingClientRect();
      return {
        rect: rect.toJSON(),
        inViewport: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth,
        hittable: button === hit || button.contains(hit),
        withinHost: rect.top >= host.top && rect.bottom <= host.bottom,
      };
    };
    try {
      await page.setViewportSize({ width, height: 621 });
      await page.evaluate((language) => window.f322MemberFixture.writeLanguage(language), language);
      if (offset)
        await page.evaluate((x) => {
          // react-rnd's translated Workspace float is a fixed-position containing block.
          const host = document.querySelector('#root');
          host.style.transform = `translate(${x}px, 80px)`;
          host.style.width = `calc(100vw - ${x}px)`;
          host.style.height = 'calc(100vh - 160px)';
        }, offset);
      await page.getByRole('button', { name: /烁烁.*gemini38/ }).click();
      const save = page.locator('.member-save-actions .member-primary');
      await save.waitFor();
      assert.equal(await save.isEnabled(), true, 'An unchanged member keeps the primary Save action');
      assert.equal((await save.evaluate(observe)).hittable, true);
      await screenshot('unchanged');
      await page.locator('select[aria-label="Transport"]').selectOption('agy-native');
      const first = await save.evaluate(observe);
      await screenshot('before-save');
      assert.equal(first.inViewport, true, JSON.stringify(first));
      assert.equal(first.hittable, true, JSON.stringify(first));
      assert.equal(first.withinHost, true, 'Save must stay inside the visible editor host, including its bottom edge');
      if (offset) {
        await page.locator('#root').evaluate((host) => {
          host.style.display = 'none';
        });
        await save.waitFor({ state: 'hidden' });
        await page.locator('#root').evaluate((host) => {
          host.style.display = '';
        });
        await save.waitFor();
        assert.equal((await save.evaluate(observe)).hittable, true);
      }
      await save.click();
      const invalidModel = page.getByRole('alert').filter({
        hasText: language === 'en' ? 'AGY Native needs a physical model ID' : 'AGY Native 模型需填写实际模型 ID',
      });
      await invalidModel.waitFor();
      const errorBox = await invalidModel.boundingBox();
      assert.ok(
        errorBox && errorBox.y >= 0 && errorBox.y + errorBox.height <= 621,
        'Validation is visible after pressing Save',
      );
      assert.equal(state.writes.length, 0);
      await screenshot('validation');
      await page.locator('input[aria-label="Model"]').fill('gemini-3.8-flash-high');
      await page
        .locator(`input[aria-label="${language === 'en' ? 'Isolated Profile ID' : '隔离 Profile ID'}"]`)
        .fill('isolated-save');
      await page
        .locator(`input[aria-label="${language === 'en' ? 'Profile root directory' : 'Profile 根目录'}"]`)
        .fill(path.join(producer.root, 'profiles'));
      await page
        .locator(`textarea[aria-label="${language === 'en' ? 'Approved workspaces' : '批准工作区'}"]`)
        .fill(producer.root);
      const expected = {
        enabled: true,
        carrier: 'native',
        profileId: 'isolated-save',
        homeRoot: path.join(producer.root, 'profiles'),
        model: 'gemini-3.8-flash-high',
        autoApprove: false,
        trustedWorkspaces: [producer.root],
      };
      if (language === 'en' && width === 390) {
        state.rejectSave = true;
        await save.click();
        await page.getByRole('alert').filter({ hasText: 'Fixture save rejected' }).waitFor();
        assert.equal(producer.persisted().agyProfile, undefined);
        assert.equal(await save.isEnabled(), true);
        state.rejectSave = false;
      }
      await save.click();
      await page
        .locator('.member-save-bar [role="status"]')
        .filter({ hasText: language === 'en' ? 'Saved' : '已保存' })
        .waitFor();
      await page.getByRole('button', { name: language === 'en' ? '‹ Members' : '‹ 成员', exact: true }).click();
      await page.getByTestId('member-list-page').waitFor();
      assert.ok((await page.locator('tr[data-cat-id="gemini38"]').innerText()).includes(expected.model));
      const writes = state.writes.filter((write) => write.path === '/api/cats/gemini38');
      assert.equal(writes.length, language === 'en' && width === 390 ? 2 : 1);
      assert.equal(state.writes.filter((write) => write.path !== '/api/cats/gemini38').length, 0);
      const saved = writes.at(-1).body;
      assert.deepEqual(saved.agyProfile, expected);
      assert.equal(saved.defaultModel, expected.model);
      assert.deepEqual(producer.persisted().agyProfile, expected);
      assert.equal(producer.persisted().agyProfile.nativeCodingGrant, undefined);
      await page.reload();
      await page.evaluate((language) => window.f322MemberFixture.writeLanguage(language), language);
      await page.getByRole('button', { name: /烁烁.*gemini38/ }).click();
      assert.equal(await page.locator('select[aria-label="Transport"]').inputValue(), 'agy-native');
      assert.equal(await page.locator('input[aria-label="Model"]').inputValue(), expected.model);
      assert.equal(
        await page
          .locator(`input[aria-label="${language === 'en' ? 'Isolated Profile ID' : '隔离 Profile ID'}"]`)
          .inputValue(),
        expected.profileId,
      );
      assert.equal(
        await page
          .locator(`textarea[aria-label="${language === 'en' ? 'Approved workspaces' : '批准工作区'}"]`)
          .inputValue(),
        producer.root,
      );
      assert.equal(await save.isVisible(), true, 'Save remains discoverable after readback');
      assert.equal(await save.isEnabled(), true, 'Unchanged Save explains its no-op when pressed');
      assert.ok(
        (await page.locator('.member-save-bar [role="status"]').innerText()).startsWith(
          language === 'en' ? 'No changes' : '没有改动',
        ),
      );
      const writeCount = state.writes.length;
      await save.click();
      assert.equal(state.writes.length, writeCount);
      await screenshot('readback');
      if (screenshots)
        writeFileSync(
          path.join(screenshots, `native-${key}.json`),
          JSON.stringify({ first, expected, writes, persisted: producer.persisted() }, null, 2),
        );
    } finally {
      await context.close();
      await producer.close();
    }
  });
