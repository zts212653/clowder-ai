import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { scene, screenshots } from './f322-members-fixture.mjs';

for (const width of [1024, 390])
  test(`DSH has one entry and adds with automatic preparation and a retained failed check (${width}px)`, async () => {
    const { context, page, state } = await scene(width);
    const order = [];
    const errors = [];
    let discoveryReads = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    let finishCheck;
    const release = new Promise((resolve) => {
      finishCheck = resolve;
    });
    let began;
    const checking = new Promise((resolve) => {
      began = resolve;
    });
    const desktop = {
      id: 'dsh-desktop',
      label: 'DSH Desktop',
      clientId: 'acp',
      installed: true,
      dshDesktop: true,
      models: [],
      acp: { command: '/desktop/dsh.cmd', startupArgs: ['--profile', 'acp'] },
    };
    try {
      await page.route('**/api/agent-providers', (route) => route.fulfill({ json: { libraries: [] } }));
      await page.route('**/api/cats/native-runtimes*', (route) =>
        route.fulfill({
          json: {
            runtimes:
              width === 1024 && discoveryReads++ === 0
                ? []
                : [
                    {
                      ...desktop,
                      id: 'acp:another-member',
                      label: 'DSH',
                      dshDesktop: false,
                      onboardingEligible: false,
                      env: { DSH_HOME: '/another/home' },
                    },
                    desktop,
                  ],
          },
        }),
      );
      await page.route('**/api/cats/dsh-setup/*', (route) => {
        const action = new URL(route.request().url()).pathname.split('/').at(-1);
        order.push(action);
        assert.notEqual(action, 'test', 'the old empty-MCP paid test must never be called');
        return route.fulfill({
          json:
            action === 'inspect'
              ? {
                  revision: 'r',
                  provider: 'custom',
                  model: 'chosen',
                  providers: [
                    { id: 'custom', credential: 'configured', models: [{ id: 'chosen', label: 'Chosen model' }] },
                  ],
                }
              : {
                  command: desktop.acp.command,
                  startupArgs: ['--profile', 'acp', '--patch', '/private/member.yml'],
                  env: { DSH_HOME: '/private/home' },
                  provider: 'custom',
                  model: 'chosen',
                },
        });
      });
      await page.route('**/api/cats', (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        const payload = route.request().postDataJSON();
        order.push('saved');
        assert.deepEqual(payload.env, { DSH_HOME: '/private/home' });
        assert.ok(!payload.accountRef, 'native Desktop creation must not reuse another member account');
        assert.equal(payload.configurationSource, 'native_tool');
        assert.equal(payload.defaultModel, '["custom","chosen"]');
        assert.deepEqual(payload.acp.startupArgs, ['--profile', 'acp', '--patch', '/private/member.yml']);
        const cat = {
          ...state.cats[0],
          accountRef: undefined,
          ...payload,
          id: payload.catId,
          configurationRevision: 'saved',
        };
        state.cats.push(cat);
        return route.fulfill({ status: 201, json: { cat } });
      });
      await page.route('**/api/cats/*/connection-check', async (route) => {
        if (route.request().method() === 'GET') return route.fulfill({ json: { state: 'unchecked' } });
        order.push('checked');
        assert.ok(order.indexOf('saved') < order.indexOf('checked'));
        began();
        await release;
        return route.fulfill({
          json:
            width === 390
              ? { state: 'unknown', reasonCode: 'check_result_unknown' }
              : { state: 'failed', reasonCode: 'tool_schema_rejected' },
        });
      });
      await page.getByRole('button', { name: '添加成员', exact: true }).click();
      const editor = page.getByTestId('member-settings-page');
      await editor.getByRole('button', { name: '鲸鲸', exact: true }).click();
      const picker = editor.getByLabel('使用工具', { exact: true });
      assert.equal(await picker.inputValue(), 'dsh', 'choosing the whale template selects the discovered Desktop');
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `dsh-picker-debug-${width}.png`) });
      assert.equal(
        await picker.locator('option[value="dsh"]').count(),
        1,
        JSON.stringify({ errors, text: await page.locator('body').innerText() }),
      );
      assert.equal(await picker.locator('option').filter({ hasText: /DSH/ }).count(), 1);
      assert.equal(await editor.getByRole('button', { name: '验证并使用此模型', exact: true }).count(), 0);
      assert.equal(await editor.getByRole('button', { name: '读取 Desktop 配置', exact: true }).count(), 0);
      const fee = editor.getByTestId('member-save-bar').getByText('费用取决于模型和工具定义规模', { exact: false });
      await fee.waitFor();
      const feeRect = await fee.boundingBox();
      assert.ok(
        feeRect && feeRect.y >= 0 && feeRect.y + feeRect.height <= page.viewportSize().height,
        'fee disclosure is visible beside the primary action',
      );
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `dsh-add-ready-${width}.png`) });
      await editor.getByRole('button', { name: '添加伙伴', exact: true }).click();
      await checking;
      await editor.getByRole('button', { name: '已保存，正在检查…', exact: true }).waitFor();
      assert.equal(
        await editor.getByTestId('member-save-bar').getByText('准备好就可以添加伙伴', { exact: true }).count(),
        0,
        'the saved member must not still be described as waiting to be added',
      );
      await editor.getByTestId('member-save-bar').getByText('成员已添加，正在检查连接', { exact: true }).waitFor();
      assert.equal(state.cats.at(-1).env.DSH_HOME, '/private/home');
      assert.ok(!state.cats.at(-1).accountRef);
      assert.equal(state.cats.at(-1).configurationSource, 'native_tool');
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `dsh-checking-${width}.png`) });
      finishCheck();
      await editor.waitFor({ state: 'detached' });
      await page.getByText(width === 390 ? '原因尚不明确' : '模型拒绝了工具参数定义', { exact: false }).waitFor();
      await page.getByText('成员与配置已保留', { exact: false }).waitFor();
      assert.equal(order.filter((step) => step === 'prepare').length, 1);
      assert.equal(order.filter((step) => step === 'saved').length, 1);
      assert.equal(order.filter((step) => step === 'checked').length, 1);
      if (width === 1024) assert.ok(discoveryReads >= 2, 'saving refreshes an initially empty Desktop discovery');
      if (screenshots) {
        await page.waitForTimeout(400); // Capture the settled toast, not its entrance transition.
        await page.screenshot({ path: path.join(screenshots, `dsh-added-check-failed-${width}.png`) });
      }
    } finally {
      finishCheck();
      await context.close();
    }
  });
