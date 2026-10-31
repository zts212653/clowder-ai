import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { scene, screenshots } from './f322-members-fixture.mjs';
import './f322-members-save-continuation.cases.mjs';
import './f322-members-native-save.cases.mjs';

for (const language of ['zh', 'en'])
  test(`member model, account name and Team entry keep separate bilingual meanings (${language})`, async () => {
    const { context, page, state } = await scene(1440, false, false, false, {
      accounts: [
        {
          id: 'codex',
          clientId: 'openai',
          displayName: 'Codex App 登录（本机默认）',
          authType: 'oauth',
          builtin: true,
          kind: 'builtin',
          models: [],
        },
      ],
    });
    try {
      Object.assign(state.cats[2], { cli: { command: 'codex' }, accountRef: 'codex', defaultModel: 'gpt-test' });
      await page.reload();
      await page.evaluate((language) => window.f322MemberFixture.writeLanguage(language), language);
      await page.getByRole('columnheader', { name: language === 'en' ? 'Model' : '模型', exact: true }).waitFor();
      await page.locator('tr[data-cat-id="fixture-c"]').waitFor();
      const heads = await page.locator('.member-table th').allTextContents();
      const accountColumn = heads.indexOf(language === 'en' ? 'Account' : '账号');
      assert.ok(accountColumn > 0, 'The account name has its own column');
      const row = page.locator('tr[data-cat-id="fixture-c"]');
      const modelColumn = heads.indexOf(language === 'en' ? 'Model' : '模型');
      assert.equal(await row.locator('td').nth(modelColumn).innerText(), 'Codex · gpt-test');
      assert.equal(
        await row.locator('td').nth(accountColumn).innerText(),
        language === 'en' ? 'Codex App login (local default)' : 'Codex App 登录（本机默认）',
      );
      assert.equal(
        await page.getByTestId('settings-open-team').innerText(),
        language === 'en' ? 'Open cat team' : '打开猫猫团队',
      );
      if (screenshots) {
        await page.screenshot({ path: path.join(screenshots, `model-account-${language}-1440.png`) });
        await page.setViewportSize({ width: 390, height: 621 });
        await row.locator('td').nth(accountColumn).scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(screenshots, `model-account-${language}-390.png`) });
      }
    } finally {
      await context.close();
    }
  });

test('recovered health stays available beyond the closed deadline in table, detail and history', async () => {
  const { context, page, state } = await scene(1440, false, false, false, { clockTime: Date.UTC(2026, 9, 3) });
  try {
    await page.clock.pauseAt(Date.UTC(2026, 9, 3, 0, 1));
    const now = await page.evaluate(() => Date.now());
    state.routingData = {
      v: 1,
      ownerId: 'fixture-owner',
      observedAt: now,
      catalogRevision: 'revision',
      preferenceRevisions: [],
      signalEvents: [
        {
          v: 1,
          ownerId: 'fixture-owner',
          eventId: 'failed',
          commandId: 'fail',
          subjectRef: { type: 'cat', catId: 'fixture-a' },
          source: 'provider_error',
          reasonCode: 'provider_error',
          observedAt: now - 300,
          evidenceRef: 'failure-source',
          eventType: 'asserted',
          state: 'unavailable',
          validUntil: now + 1000,
        },
        {
          v: 1,
          ownerId: 'fixture-owner',
          eventId: 'success',
          commandId: 'success',
          subjectRef: { type: 'cat', catId: 'fixture-a' },
          source: 'dispatch_success',
          reasonCode: 'dispatch_success_probe',
          observedAt: now - 100,
          probeStartedAt: now - 200,
          evidenceRef: 'success-source',
          eventType: 'recovered',
          state: 'available',
          closesSignalIds: [],
        },
      ],
      resolution: {
        state: 'fresh',
        inputRevisionRef: 'fixture',
        sourceRefs: { signalEventIds: ['failed', 'success'], preferenceRevisionIds: [], dossierRevisions: [] },
        snapshot: {
          v: 1,
          ownerId: 'fixture-owner',
          observedAt: now,
          catalogRevision: 'revision',
          candidates: [
            {
              binding: { v: 1, catId: 'fixture-a', providerId: 'anthropic', provenQuotaPools: [] },
              profile: { state: 'absent' },
              availability: 'available',
              freshness: 'fresh',
              effect: 'eligible',
              matchedPreferences: [],
              reasons: [
                {
                  code: 'routing_signal_recovered',
                  summary: 'dispatch_success_probe',
                  sourceRefs: ['failed', 'success'],
                },
              ],
            },
          ],
        },
      },
    };
    await page.reload();
    const status = page.locator('tr[data-cat-id="fixture-a"] .member-status');
    await status.getByText('已恢复', { exact: true }).waitFor();
    assert.equal(await status.getByText(/至 /).count(), 0);
    await page.clock.runFor(1200);
    assert.equal(await status.getByText('已恢复', { exact: true }).count(), 1);
    await page.getByRole('button', { name: /测试甲.*fixture-a/ }).click();
    await page.getByTestId('member-detail-page').waitFor();
    assert.equal(await page.locator('.member-detail-status').getByText('可用', { exact: true }).count(), 1);
    assert.equal(await page.locator('.member-history-row').count(), 0, 'Diagnostic records are no longer in settings');
    assert.equal(await page.getByTestId('member-open-records').count(), 1);
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'r1-recovered-health.png') });
  } finally {
    await context.close();
  }
});
test('untouched add uses v2 Chinese and English validation without a write', async () => {
  const { context, page, state } = await scene(390);
  try {
    await page.getByRole('button', { name: '添加成员', exact: true }).click();
    await page.getByRole('button', { name: '添加', exact: true }).click();
    const zh = page.getByRole('alert').filter({ hasText: '还差 4 项才能添加：账号、名称、角色描述、@ 名字。' });
    await zh.waitFor();
    const zhBox = await zh.boundingBox();
    assert.ok(
      zhBox && zhBox.y >= 0 && zhBox.y + zhBox.height < page.viewportSize().height - 70,
      'Chinese validation is in the viewport above the save bar',
    );
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'r1-blank-add-zh.png') });
    await page.evaluate(() => window.f322MemberFixture.writeLanguage('en'));
    await page.getByRole('button', { name: 'Retry save', exact: true }).click();
    const en = page
      .getByRole('alert')
      .filter({ hasText: '4 more fields needed to add: Account, Name, Role, Mention names.' });
    await en.waitFor();
    const enBox = await en.boundingBox();
    assert.ok(
      enBox && enBox.y >= 0 && enBox.y + enBox.height < page.viewportSize().height - 70,
      'English validation is in the viewport above the save bar',
    );
    assert.equal(state.writes.length, 0);
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'r1-blank-add-en.png') });
  } finally {
    await context.close();
  }
});
test('config retry and rejected default PUT recover without inventing a Codex draft', async () => {
  const { context, page, state } = await scene();
  try {
    state.rejectConfig = true;
    await page.reload();
    await page.getByRole('alert').filter({ hasText: '读取失败' }).waitFor();
    assert.equal(await page.getByText('正在读取成员配置…', { exact: true }).count(), 0);
    state.rejectConfig = false;
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.getByTestId('member-list-page').waitFor();
    state.rejectDefaultSave = true;
    await page.getByLabel('默认猫', { exact: true }).selectOption('fixture-c');
    await page.getByRole('alert').filter({ hasText: '默认猫保存失败' }).waitFor();
    assert.equal(await page.getByLabel('默认猫', { exact: true }).isEnabled(), true);
    state.rejectDefaultSave = false;
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('select[aria-label="默认猫"]')?.value === 'fixture-c');
    assert.equal(state.writes.filter((w) => w.path === '/api/config/default-cat').length, 2);
    assert.equal(state.defaultId, 'fixture-c');
    state.rejectConfig = true;
    await page.getByRole('button', { name: /测试丙.*fixture-c/ }).click();
    await page.getByText('Codex 运行参数加载失败 (503)', { exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: '未保存修改' }).count(), 0);
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'r1-codex-config-error.png') });
  } finally {
    await context.close();
  }
});
