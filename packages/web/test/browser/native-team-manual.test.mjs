import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { callRealPartner, openLiveJourney, roleIdentity } from './native-team-live.harness.mjs';
import { assertLivePageHealthy } from './native-team-observers.mjs';

test(
  'installed app: manual creation, nickname save, actual model/effort choices and reversible runtime drafts',
  { timeout: 300000 },
  async () => {
    const journey = await openLiveJourney();
    const { page, request, record, web, log } = journey;
    record.scenario = 'manual-create-and-configure';
    try {
      const before = (await request('/api/cats')).cats;
      record.originalRoles = before.map(roleIdentity);
      const token = randomUUID().slice(0, 8);
      const nickname = `手动验收-${token}`;
      await page.goto(new URL('/settings?s=members&view=add&manual=1&shell=v2&lang=zh', web).href);
      await page.getByRole('button', { name: '砚砚', exact: true }).click();
      await page
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: '选择伙伴模板', exact: true }) })
        .getByRole('textbox', { name: '名字', exact: true })
        .fill(`验收伙伴-${token}`);
      await page.getByRole('button', { name: '模型与工具', exact: true }).click();
      await page.getByLabel('使用工具', { exact: true }).selectOption('codex');
      await page.getByRole('button', { name: '身份与职责', exact: true }).click();
      await page.getByRole('textbox', { name: '昵称', exact: true }).fill(nickname);
      const createdResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/cats' &&
          response.request().method() === 'POST' &&
          response.status() !== 401,
      );
      await page.getByRole('button', { name: '添加伙伴', exact: true }).click();
      const response = await createdResponse;
      assert.equal(response.status(), 201);
      const created = (await response.json()).cat;
      record.createdRole = roleIdentity(created);
      assert.ok(!before.some((cat) => cat.id === created.id));
      assert.ok(created.id.length <= 24, 'Manual creation must use a short ID');
      assert.ok(created.avatar && created.avatar !== '/avatars/default.png');
      await log('manual-role-created-with-existing-native-configuration', { catId: created.id });

      await page.goto(new URL(`/settings?s=members&cat=${created.id}&shell=v2&lang=zh`, web).href);
      await page.getByRole('button', { name: '身份与职责', exact: true }).click();
      const revised = `${nickname}-已更新`;
      await page.getByRole('textbox', { name: '昵称', exact: true }).fill(revised);
      const patchResponse = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === `/api/cats/${created.id}` &&
          res.request().method() === 'PATCH' &&
          res.status() !== 401,
      );
      const started = Date.now();
      await page.getByRole('button', { name: '保存', exact: true }).click();
      const patched = await patchResponse;
      record.save = { responseMs: Date.now() - started, status: patched.status() };
      assert.equal(patched.status(), 200);
      await page.getByTestId('member-save-bar').waitFor({ state: 'hidden' });
      record.save.uiCompletedMs = Date.now() - started;
      record.save.traceHeaders = Object.fromEntries(
        Object.entries(patched.request().headers()).filter(([key]) =>
          ['x-clowder-save-id', 'x-clowder-save-request'].includes(key),
        ),
      );
      assert.ok(record.save.traceHeaders['x-clowder-save-id']);
      assert.ok(
        record.save.uiCompletedMs < 5000,
        'This warm author profile must not regress to the reported 5–11s save',
      );
      await page.reload();
      await page.getByRole('button', { name: '身份与职责', exact: true }).click();
      assert.equal(await page.getByRole('textbox', { name: '昵称', exact: true }).inputValue(), revised);
      await page.getByRole('heading', { name: created.displayName, exact: true }).waitFor();
      await page.goto(new URL('/settings?s=members&shell=v2&lang=zh', web).href);
      const row = page.getByRole('row').filter({ has: page.getByText(revised, { exact: true }) });
      await row.waitFor();
      await row.getByText(created.displayName, { exact: true }).waitFor();
      await row.scrollIntoViewIfNeeded();
      await journey.screenshot('manual-nickname-retained');
      await log('nickname-persisted-and-display-priority-verified', record.save);

      await page.goto(new URL(`/settings?s=members&cat=${created.id}&shell=v2&lang=zh`, web).href);
      await page.getByRole('button', { name: '模型与工具', exact: true }).click();
      const model = page.getByRole('combobox', { name: '模型', exact: true });
      await model.click();
      const choices = page.getByRole('listbox').getByRole('option');
      await choices.nth(1).waitFor();
      record.modelChoices = await choices.allInnerTexts();
      await journey.screenshot('actual-codex-model-choices');
      await choices.nth(1).click();
      const effort = page.getByRole('combobox', { name: '思考强度', exact: true });
      await effort.click();
      const efforts = page.getByRole('listbox').getByRole('option');
      await efforts.nth(1).waitFor();
      record.effortChoices = await efforts.allInnerTexts();
      await efforts.first().click();
      await model.click();
      await page.getByRole('listbox').getByRole('option').first().click();
      assert.equal(await page.getByRole('button', { name: '恢复跟随', exact: true }).count(), 0);
      await page.getByTestId('member-save-bar').waitFor({ state: 'hidden' });
      const tool = page.getByLabel('使用工具', { exact: true });
      await tool.selectOption('claude');
      assert.equal(await tool.inputValue(), 'claude', 'One selection must switch the draft without confirmation');
      await tool.selectOption('codex');
      await page.getByTestId('member-save-bar').waitFor({ state: 'hidden' });
      assert.match(await model.innerText(), /跟随 Codex/);
      await log('model-effort-follow-option-and-runtime-roundtrip-verified');

      const after = (await request('/api/cats')).cats;
      assert.equal(after.length, before.length + 1);
      for (const original of before)
        assert.deepEqual(roleIdentity(after.find((cat) => cat.id === original.id)), roleIdentity(original));
      const manual = after.find((cat) => cat.id === created.id);
      assert.equal(manual.nickname, revised);
      assert.equal(manual.clientId, 'openai');
      assert.equal(manual.defaultModel, '', 'Uncommitted model/runtime drafts must not alter the saved role');
      assert.ok((await callRealPartner(journey, manual)).passed);
      assertLivePageHealthy(record);
      await log('manual-role-real-task-and-original-roles-retained');
    } catch (error) {
      record.failure = error.message;
      await journey.screenshot('manual-config-failure');
      throw error;
    } finally {
      await journey.close();
    }
  },
);
