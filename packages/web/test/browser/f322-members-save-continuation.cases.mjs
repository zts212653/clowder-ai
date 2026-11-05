import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scene, screenshots } from './f322-members-fixture.mjs';
import { nativeMemberProducer } from './f322-members-native-producer.fixture.mjs';

const accounts = [
  {
    id: 'gemini',
    clientId: 'google',
    displayName: 'Gemini (OAuth)',
    authType: 'oauth',
    kind: 'builtin',
    builtin: true,
    models: [],
  },
];
const openMember = (page) => page.getByRole('button', { name: /烁烁.*gemini38/ }).click();
const saveButton = (page, language) =>
  page.getByRole('button', { name: language === 'en' ? 'Save' : '保存', exact: true });
const languageOn = (page, language) =>
  page.evaluate((value) => window.f322MemberFixture.writeLanguage(value), language);

// The older Native path covers pixels and Profile fields; this covers a normal account,
// the end of the long form, native Tab/Enter navigation, and the original file producer.
for (const [language, width] of [
  ['zh', 1024],
  ['en', 390],
])
  test(`normal account keeps long-form keyboard Save and real reopened configuration (${language}/${width})`, async () => {
    // F325 retired Google CLI. Exercise the supported ordinary account path with Claude.
    const producer = await nativeMemberProducer(undefined, {
      cliCommand: 'claude',
      clientId: 'anthropic',
      accountRef: 'claude',
      initialModel: 'claude-baseline',
    });
    const { context, page, state } = await scene(width, false, false, false, {
      catsProducer: producer,
      accounts: [{ ...accounts[0], id: 'claude', clientId: 'anthropic', displayName: 'Claude (OAuth)' }],
    });
    try {
      await page.setViewportSize({ width, height: 621 });
      await languageOn(page, language);
      await openMember(page);
      assert.equal(await page.locator('select[aria-label="Client"]').inputValue(), 'anthropic');
      await page.locator('input[aria-label="Model"]').fill('claude-normal-account');
      const editor = page.getByTestId('member-detail-page');
      const lastField = editor.locator('input:not([disabled]),select:not([disabled]),textarea:not([disabled])').last();
      await lastField.scrollIntoViewIfNeeded();
      await lastField.focus();
      const save = saveButton(page, language);
      const visible = await save.evaluate((button) => {
        const r = button.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return r.y >= 0 && r.bottom <= innerHeight && (hit === button || button.contains(hit));
      });
      assert.equal(visible, true, 'Save remains visible while the long form is scrolled');
      let tabs = 0;
      while (!(await save.evaluate((button) => button === document.activeElement)) && tabs < 12) {
        await page.keyboard.press('Tab');
        tabs++;
      }
      assert.equal(
        await save.evaluate((button) => button === document.activeElement),
        true,
        'Native keyboard traversal reaches Save from the end of the editor',
      );
      if (screenshots)
        await page.screenshot({ path: path.join(screenshots, `normal-${language}-${width}-keyboard.png`) });
      await page.keyboard.press('Enter');
      await page
        .locator('.member-save-bar [role="status"]')
        .filter({ hasText: language === 'en' ? 'Saved' : '已保存' })
        .waitFor();
      assert.equal(state.writes.length, 1);
      assert.equal(state.writes[0].body.defaultModel, 'claude-normal-account');
      assert.equal(producer.persisted().defaultModel, 'claude-normal-account');
      assert.equal(producer.persisted().agyProfile, undefined);
      assert.equal(producer.persisted().accountRef, 'claude');
      assert.equal(producer.persisted().cli.command, 'claude');
      await page.reload();
      await languageOn(page, language);
      await openMember(page);
      assert.equal(await page.locator('input[aria-label="Model"]').inputValue(), 'claude-normal-account');
      assert.equal(await page.locator('select[aria-label="Client"]').inputValue(), 'anthropic');
      assert.equal(await save.isVisible(), true);
      assert.equal(await save.isEnabled(), true, 'Reopened configuration keeps the same primary Save action');
      if (screenshots)
        await page.screenshot({ path: path.join(screenshots, `normal-${language}-${width}-readback.png`) });
      if (screenshots)
        writeFileSync(
          path.join(screenshots, `normal-${language}-${width}.json`),
          JSON.stringify({ tabs, writes: state.writes, persisted: producer.persisted() }, null, 2),
        );
    } finally {
      await context.close();
      await producer.close();
    }
  });

test('Native explicit automatic mode persists, and returning to restricted mode validates without a write', async () => {
  const producer = await nativeMemberProducer();
  const { context, page, state } = await scene(1024, false, false, false, { catsProducer: producer, accounts });
  try {
    await languageOn(page, 'en');
    await openMember(page);
    await page.locator('select[aria-label="Transport"]').selectOption('agy-native');
    await page.locator('input[aria-label="Model"]').fill('gemini-3.8-flash-high');
    await page
      .getByRole('textbox', { name: 'Profile root directory', exact: true })
      .fill(path.join(producer.root, 'profiles'));
    const permission = page.getByRole('combobox', { name: 'Execution permissions', exact: true });
    await permission.selectOption('auto');
    assert.equal(await page.getByRole('textbox', { name: 'Approved workspaces', exact: true }).count(), 0);
    await saveButton(page, 'en').click();
    await page.locator('.member-save-bar [role="status"]').filter({ hasText: 'Saved' }).waitFor();
    assert.equal(producer.persisted().agyProfile.autoApprove, true);
    assert.deepEqual(producer.persisted().agyProfile.trustedWorkspaces, []);
    assert.equal(producer.persisted().agyProfile.nativeCodingGrant, undefined);
    await page.reload();
    await languageOn(page, 'en');
    await openMember(page);
    assert.equal(await permission.inputValue(), 'auto');
    await permission.selectOption('restricted');
    await saveButton(page, 'en').click();
    await page.getByRole('alert').filter({ hasText: 'AGY Native needs at least one approved workspace.' }).waitFor();
    assert.equal(state.writes.length, 1, 'Restricted empty workspace validation performs no new write');
    assert.equal(
      producer.persisted().agyProfile.autoApprove,
      true,
      'Failed validation retains the saved configuration',
    );
    if (screenshots)
      await page.screenshot({ path: path.join(screenshots, 'native-permission-restricted-validation.png') });
  } finally {
    await context.close();
    await producer.close();
  }
});
