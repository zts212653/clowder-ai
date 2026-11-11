import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { scene, screenshots } from './f322-members-fixture.mjs';

for (const width of [1920, 1024, 390])
  test(`DSH has one entry and adds with automatic preparation and a retained failed check (${width}px)`, async () => {
    const { context, page, state } = await scene(width, false, false, false, { deviceScaleFactor: 2 });
    const alternateLabel = 'Other model with a long provider-specific name and a retained explicit route';
    const expectedModel = width === 1920 ? 'other' : 'chosen';
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
    let beginInspection;
    const inspecting = new Promise((resolve) => {
      beginInspection = resolve;
    });
    let finishInspection;
    const inspected = new Promise((resolve) => {
      finishInspection = resolve;
    });
    let inspectionBusy = false;
    let inspectionRequests = 0;
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
      await page.route('**/api/cats/dsh-setup/*', async (route) => {
        const action = new URL(route.request().url()).pathname.split('/').at(-1);
        order.push(action);
        assert.notEqual(action, 'test', 'the old empty-MCP paid test must never be called');
        if (action === 'prepare') {
          assert.equal(route.request().postDataJSON().provider, 'custom');
          assert.equal(route.request().postDataJSON().model, expectedModel);
        }
        if (action === 'inspect' && width === 390) {
          inspectionRequests += 1;
          if (inspectionBusy) return route.fulfill({ status: 409, json: { error: 'dsh_setup_busy' } });
          inspectionBusy = true;
          beginInspection();
          await inspected;
          inspectionBusy = false;
        }
        return route.fulfill({
          json:
            action === 'inspect'
              ? {
                  revision: 'r',
                  provider: 'custom',
                  model: 'chosen',
                  providers: [
                    {
                      id: 'custom',
                      credential: 'configured',
                      models: [
                        { id: 'chosen', label: 'Chosen model' },
                        { id: 'other', label: alternateLabel },
                      ],
                    },
                  ],
                }
              : {
                  command: desktop.acp.command,
                  startupArgs: ['--profile', 'acp', '--patch', '/private/member.yml'],
                  env: { DSH_HOME: '/private/home' },
                  provider: 'custom',
                  model: route.request().postDataJSON().model,
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
        assert.equal(payload.defaultModel, JSON.stringify(['custom', expectedModel]));
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
        assert.equal(state.cats.at(-1).defaultModel, JSON.stringify(['custom', expectedModel]));
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
      const model = editor.getByRole('combobox', { name: '模型', exact: true });
      const effort = editor.getByRole('combobox', { name: '思考强度', exact: true });
      await model.waitFor({ state: 'visible' });
      assert.equal(await model.evaluate((element) => Boolean(element.closest('details:not([open])'))), false);
      await model.scrollIntoViewIfNeeded();
      const modelBox = await model.boundingBox();
      const effortBox = await effort.boundingBox();
      assert.ok(modelBox.height >= 44, 'the model uses the shared 44px target');
      if (width === 390) assert.ok(effortBox.y > modelBox.y, 'narrow screens stack model and effort');
      else assert.ok(effortBox.x > modelBox.x && Math.abs(effortBox.y - modelBox.y) < 2, 'desktop fields share a row');
      if (width === 1920) {
        await model.getByText('Chosen model', { exact: false }).waitFor();
        await model.click();
        const search = editor.getByRole('textbox', { name: '搜索模型', exact: true });
        await search.fill('Other model');
        await search.press('ArrowDown');
        await page.keyboard.press('Enter');
        await model.getByText(alternateLabel, { exact: false }).waitFor();
        await model.click();
        await search.press('Escape');
        assert.equal(await model.evaluate((element) => element === document.activeElement), true);
        await page.setViewportSize({ width: 390, height: 900 });
        await model.scrollIntoViewIfNeeded();
        assert.ok(
          await editor.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
          'long routes do not overflow',
        );
        if (screenshots) await page.screenshot({ path: path.join(screenshots, 'dsh-model-selected-narrow.png') });
        await page.setViewportSize({ width, height: 900 });
      }
      await picker.scrollIntoViewIfNeeded();
      const fee = editor.getByTestId('member-save-bar').getByText('费用取决于模型和工具定义规模', { exact: false });
      await fee.waitFor();
      const feeRect = await fee.boundingBox();
      assert.ok(
        feeRect && feeRect.y >= 0 && feeRect.y + feeRect.height <= page.viewportSize().height,
        'fee disclosure is visible beside the primary action',
      );
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `dsh-add-ready-${width}.png`) });
      if (width === 390) await inspecting;
      const freshDiscovery =
        width === 390
          ? page.waitForResponse((response) => new URL(response.url()).pathname === '/api/cats/native-runtimes')
          : undefined;
      await editor.getByRole('button', { name: '添加伙伴', exact: true }).click();
      if (freshDiscovery) {
        await freshDiscovery;
        await page.waitForTimeout(300);
        assert.equal(inspectionRequests, 1, 'save must reuse the unfinished panel inspection');
        finishInspection();
      }
      await checking;
      await editor.getByRole('button', { name: '已保存，正在检查…', exact: true }).waitFor();
      assert.match(
        await picker.locator('option:checked').innerText(),
        /DSH.*已安装/,
        'the saved Desktop must use the discovery confirmed during preparation',
      );
      await model.getByText(width === 1920 ? alternateLabel : 'Chosen model', { exact: false }).waitFor();
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
      finishInspection();
      finishCheck();
      await context.close();
    }
  });
