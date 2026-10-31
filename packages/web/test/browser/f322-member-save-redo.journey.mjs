import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { scene, screenshots } from './f322-members-fixture.mjs';

for (const [width, language, dark] of [
  [1440, 'zh', false],
  [390, 'en', true],
]) {
  test(`shared member form and save styling from both hosts (${width}/${language})`, async () => {
    const forms = [];
    const paints = [];
    for (const classic of [false, true]) {
      const { context, page, state } = await scene(width, dark, classic, false, {
        accounts: [
          {
            id: 'codex',
            clientId: 'openai',
            displayName: 'Codex',
            authType: 'oauth',
            builtin: true,
            kind: 'builtin',
            models: [],
          },
        ],
      });
      try {
        Object.assign(state.cats[2], { accountRef: 'codex', cli: { command: 'codex' }, defaultModel: 'gpt-test' });
        await page.reload();
        if (dark) await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
        assert.equal(await page.locator('html').getAttribute('data-theme'), dark ? 'dark' : null);
        await page.evaluate((value) => window.f322MemberFixture.writeLanguage(value), language);
        await page.getByRole('button', { name: /测试丙.*fixture-c/ }).click();
        await page.locator('select[aria-label="Codex Sandbox"]:enabled').waitFor();
        const fields = page.locator('.member-editor-fields');
        paints.push(
          await fields
            .locator('select[aria-label="Codex Sandbox"]')
            .evaluate((input) => getComputedStyle(input.closest('section')).backgroundColor),
        );
        forms.push(
          await fields.evaluate((node) => {
            const form = node.cloneNode(true);
            form.querySelector('[id$="-delete"]')?.remove();
            return form.innerText || form.textContent;
          }),
        );
        const advanced = page.locator('[id$="-advanced"] > section');
        const deletion = page.locator('[id$="-delete"]');
        if (!classic) {
          const padding = await deletion.evaluate((node) => parseFloat(getComputedStyle(node).paddingLeft));
          const referencePadding = await advanced.evaluate((node) => parseFloat(getComputedStyle(node).paddingLeft));
          assert.ok(padding > 0, 'Delete card has readable inner spacing');
          assert.equal(padding, referencePadding, 'Delete card aligns with the other form cards');
        } else {
          assert.equal(await deletion.count(), 0, 'Chat cannot invent a delete action without the host callback');
        }
        await page.locator('input[aria-label="Nickname"]').fill('Changed member');
        const feedback = page.getByTestId('member-save-feedback');
        const emphasis = feedback.locator('strong');
        assert.equal(await emphasis.innerText(), language === 'zh' ? '1 处修改还没保存：' : '1 unsaved change: ');
        assert.notEqual(
          await emphasis.evaluate((node) => getComputedStyle(node).color),
          await feedback.locator('p').evaluate((node) => getComputedStyle(node).color),
        );
        const button = feedback.getByRole('button', { name: language === 'zh' ? '保存' : 'Save', exact: true });
        await (classic ? advanced : deletion).scrollIntoViewIfNeeded();
        assert.equal(
          await button.evaluate((node) => {
            const r = node.getBoundingClientRect();
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return hit === node || node.contains(hit);
          }),
          true,
        );
        if (screenshots)
          await page.screenshot({
            path: path.join(screenshots, `shared-form-${width}-${language}-${classic ? 'modal' : 'page'}.png`),
          });
        assert.equal(state.writes.length, 0);
      } finally {
        await context.close();
      }
    }
    assert.equal(forms[1], forms[0], 'The visible member form is identical in Settings and Chat');
    assert.equal(paints[1], paints[0], 'Classic Chat also uses the shared paper card tokens');
  });
}

for (const [width, language, classic, dark] of [
  [1440, 'zh', false, false],
  [390, 'en', false, true],
  [390, 'zh', true, false],
]) {
  test(`member save redo: visible actions, no-op, validation, failure, retry and reopen (${width}/${language}/${classic ? 'classic' : 'v2'})`, async () => {
    const { context, page, state } = await scene(width, dark, classic);
    const en = language === 'en';
    const save = () => page.getByRole('button', { name: en ? 'Save' : '保存', exact: true });
    const footer = page.getByTestId('member-save-feedback');
    try {
      await page.evaluate((value) => window.f322MemberFixture.writeLanguage(value), language);
      await page.getByRole('button', { name: /测试甲.*fixture-a/ }).click();
      await save().waitFor();
      const visible = () =>
        save().evaluate((button) => {
          const r = button.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return r.top >= 0 && r.bottom <= innerHeight && (hit === button || button.contains(hit));
        });
      assert.equal(await visible(), true, 'Save is visible and hittable immediately on entry');
      assert.equal(await save().isEnabled(), true);
      const brand = await save().evaluate((button) => getComputedStyle(button).backgroundColor);
      await save().click();
      await footer.getByText(en ? 'There are no changes to save' : '没有要保存的修改', { exact: true }).waitFor();
      assert.equal(state.writes.length, 0);
      await page.locator('input[aria-label="Name"]').fill('');
      await save().click();
      await footer.getByRole('alert').waitFor();
      assert.equal(state.writes.length, 0);
      await page.locator('input[aria-label="Name"]').fill('隔离测试甲');
      await page.locator('input[aria-label="Model"]').fill('saved-model');
      await page.locator('input[aria-label="Nickname"]').fill('Changed nickname');
      await page.locator('input[aria-label="Nickname"]').scrollIntoViewIfNeeded();
      assert.equal(await visible(), true, 'Save remains visible deep in the form');
      assert.equal(await save().evaluate((button) => getComputedStyle(button).backgroundColor), brand);
      assert.equal(
        await page
          .locator('input[aria-label="Model"]')
          .evaluate(
            (input) =>
              input.closest('label')?.textContent.includes('Changed') ||
              input.closest('label')?.textContent.includes('已改'),
          ),
        true,
      );
      if (screenshots)
        await page.screenshot({ path: path.join(screenshots, `redo-dirty-${width}-${language}-${classic}.png`) });
      state.rejectSave = true;
      await save().click();
      await footer.getByRole('alert').filter({ hasText: '没有权限' }).waitFor();
      assert.equal(await page.locator('input[aria-label="Model"]').inputValue(), 'saved-model');
      state.rejectSave = false;
      await footer.getByRole('button', { name: en ? 'Retry save' : '重新保存', exact: true }).click();
      await footer
        .getByRole('status')
        .filter({ hasText: en ? 'Saved' : '已保存' })
        .waitFor();
      assert.equal(state.cats[0].defaultModel, 'saved-model');
      assert.equal(await save().isEnabled(), true);
      if (screenshots)
        await page.screenshot({ path: path.join(screenshots, `redo-saved-${width}-${language}-${classic}.png`) });
      if (classic) await page.getByRole('button', { name: '关闭', exact: true }).click();
      else await page.getByRole('button', { name: en ? '‹ Members' : '‹ 成员', exact: true }).click();
      await page.getByRole('button', { name: /Changed nickname.*fixture-a/ }).click();
      assert.equal(await page.locator('input[aria-label="Model"]').inputValue(), 'saved-model');
      assert.equal(await visible(), true);
      assert.equal(await page.locator('#member-history').count(), 0);
    } finally {
      await context.close();
    }
  });
}

for (const [width, language, classic] of [
  [1440, 'zh', false],
  [390, 'en', true],
]) {
  test(`member operation failures retain context and retry the original action (${width}/${language}/${classic ? 'classic' : 'v2'})`, async () => {
    const { context, page, state } = await scene(width, false, classic);
    const en = language === 'en';
    const footer = page.getByTestId('member-save-feedback');
    const save = () => footer.getByRole('button', { name: en ? 'Save' : '保存', exact: true });
    let rejectAccounts = true;
    let accountReads = 0;
    await page.route('**/api/accounts', async (route) => {
      accountReads++;
      return route.fulfill({
        status: rejectAccounts ? 503 : 200,
        json: rejectAccounts ? { error: 'Accounts unavailable' } : { providers: state.accounts },
      });
    });
    try {
      await page.evaluate((value) => window.f322MemberFixture.writeLanguage(value), language);
      await page.getByRole('button', { name: /测试甲.*fixture-a/ }).click();
      const accounts = page.getByTestId('member-operation-accounts');
      await accounts.getByRole('button', { name: en ? 'Reload accounts' : '重新加载账号' }).waitFor();
      assert.doesNotMatch(await footer.innerText(), /Not saved|没保存上|Retry save|重新保存/);
      await save().click();
      assert.equal(await accounts.isVisible(), true, 'No-op Save cannot clear an unrelated load error');
      await page.locator('input[aria-label="Nickname"]').fill('Keep this draft');
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `operation-accounts-${language}.png`) });
      const previousReads = accountReads;
      rejectAccounts = false;
      await accounts.getByRole('button').click();
      await accounts.waitFor({ state: 'detached' });
      assert.equal(accountReads, previousReads + 1, 'Retry must perform a fresh account read');
      assert.equal(await page.locator('input[aria-label="Nickname"]').inputValue(), 'Keep this draft');
      assert.equal(state.writes.length, 0);

      for (const [kind, url, mime, retryLabel] of [
        ['avatar', 'avatar', 'image/png', en ? 'Retry avatar upload' : '重新上传头像'],
        ['audio', 'ref-audio', 'audio/wav', en ? 'Retry audio upload' : '重新上传参考音频'],
      ]) {
        let rejectUpload = true;
        const bodies = [];
        await page.route(`**/api/uploads/${url}`, async (route) => {
          bodies.push(route.request().postDataBuffer());
          return route.fulfill({
            status: rejectUpload ? 503 : 200,
            json: rejectUpload ? { error: `${kind} unavailable` } : { url: `/uploads/retried-${kind}` },
          });
        });
        await page.locator(`input[type="file"][accept^="${mime}"]`).setInputFiles({
          name: `sample.${kind === 'avatar' ? 'png' : 'wav'}`,
          mimeType: mime,
          buffer: Buffer.from(`retained-${kind}-file`),
        });
        const issue = page.getByTestId(`member-operation-${kind}`);
        await issue.getByRole('button', { name: retryLabel }).waitFor();
        await issue.scrollIntoViewIfNeeded();
        assert.equal(
          await save().evaluate((button) => {
            const r = button.getBoundingClientRect();
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return r.top >= 0 && r.bottom <= innerHeight && (hit === button || button.contains(hit));
          }),
          true,
          'Save stays visible and hittable beside the field failure',
        );
        if (classic) {
          const dialog = await page.getByRole('dialog').boundingBox();
          const bar = await page.locator('.member-save-modal').boundingBox();
          assert.ok(dialog && bar);
          assert.ok(
            Math.abs(bar.y + bar.height - dialog.y - dialog.height) < 1,
            'The modal footer stays at the dialog bottom after deep scrolling',
          );
        }
        assert.doesNotMatch(await footer.innerText(), /Not saved|没保存上|Retry save|重新保存/);
        if (screenshots) await page.screenshot({ path: path.join(screenshots, `operation-${kind}-${language}.png`) });
        rejectUpload = false;
        await issue.getByRole('button').click();
        await issue.waitFor({ state: 'detached' });
        assert.equal(bodies.length, 2);
        for (const body of bodies) assert.ok(body.includes(Buffer.from(`retained-${kind}-file`)));
        assert.equal(await page.locator('input[aria-label="Nickname"]').inputValue(), 'Keep this draft');
        assert.equal(state.writes.length, 0, 'Upload retry does not silently save the member');
      }
    } finally {
      await context.close();
    }
  });
}
