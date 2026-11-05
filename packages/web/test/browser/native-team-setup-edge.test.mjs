import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertLivePageHealthy, observePageFaults } from './native-team-observers.mjs';
import { create, runtimes, select, setup } from './native-team-setup.harness.mjs';

test('console errors and failed HTTP requests cannot disappear from live acceptance', { timeout: 30000 }, async () => {
  const state = await setup();
  try {
    const record = { pageErrors: [], dialogs: [] };
    await observePageFaults(state.page, record);
    await state.page.route('**/observer-fault-fixture', (route) =>
      route.fulfill({ status: 503, body: 'expected fixture' }),
    );
    await state.page.route('**/observer-reset-fixture', (route) => route.abort('connectionreset'));
    await state.page.evaluate(async () => {
      console.error('expected-observer-console-error');
      await fetch('/observer-fault-fixture');
      await fetch('/observer-reset-fixture').catch(() => {});
    });
    await state.page.waitForTimeout(100);
    assert.ok(record.consoleErrors?.some((message) => message.includes('expected-observer-console-error')));
    assert.ok(record.networkErrors?.some((error) => error.status === 503 && error.path === '/observer-fault-fixture'));
    assert.ok(record.networkErrors?.some((error) => error.path === '/observer-reset-fixture' && error.failure));
    assert.throws(() => assertLivePageHealthy(record), /Unexpected renderer faults/);
  } finally {
    await state.context.close();
  }
});

test(
  'unexpected blocking dialogs and JavaScript faults are observed instead of silently accepted',
  { timeout: 30000 },
  async () => {
    const state = await setup();
    try {
      const record = { pageErrors: [], dialogs: [] };
      await observePageFaults(state.page, record);
      await state.page.evaluate(() => window.alert('expected-diagnostic-dialog'));
      assert.deepEqual(record.dialogs, [{ type: 'alert', message: 'expected-diagnostic-dialog' }]);
      await state.page.evaluate(() => {
        setTimeout(() => {
          throw new Error('expected-diagnostic-page-error');
        }, 0);
      });
      await state.page.waitForTimeout(100);
      assert.deepEqual(record.pageErrors, ['expected-diagnostic-page-error']);
      assert.equal(state.writes.length, 0);
    } finally {
      await state.context.close();
    }
  },
);

test(
  'regression: deselecting a logged-out Claude never submits or blocks that partner',
  { timeout: 30000 },
  async () => {
    const tools = runtimes.map((runtime) =>
      runtime.id === 'claude'
        ? { ...runtime, readiness: { status: 'login_required', loginCommand: 'claude auth login' } }
        : runtime,
    );
    const state = await setup({ runtimes: tools });
    try {
      await select(state, 29);
      await create(state.page).click();
      await state.panel.waitFor({ state: 'hidden' });
      assert.equal(state.writes.length, 4);
      assert.ok(state.writes.every(({ payload }) => payload.clientId !== 'anthropic'));
      assert.deepEqual(state.errors, []);
    } finally {
      await state.context.close();
    }
  },
);

test('unavailable ACP adapters cannot be selected; other tools can still be created', { timeout: 30000 }, async () => {
  const tools = runtimes.map((runtime) =>
    runtime.id === 'pi' ? { ...runtime, acp: undefined, discoveryStatus: 'adapter_missing' } : runtime,
  );
  const state = await setup({ runtimes: tools });
  try {
    await state.page.getByText('其他工具与安装帮助', { exact: true }).click();
    assert.ok(await state.page.getByRole('checkbox', { name: '加入 Pi 伙伴', exact: true }).isDisabled());
    await create(state.page).click();
    await state.panel.waitFor({ state: 'hidden' });
    assert.equal(state.writes.length, 4);
    assert.deepEqual(state.errors, []);
  } finally {
    await state.context.close();
  }
});

test('deselection persists across a page reload and a fresh detection', { timeout: 30000 }, async () => {
  const state = await setup();
  try {
    await select(state, 20);
    await state.page.reload();
    await state.panel.waitFor();
    await state.page.getByText('正在检测本机工具并匹配角色…', { exact: true }).waitFor({ state: 'hidden' });
    await state.page.getByRole('button', { name: '重新检测', exact: true }).click();
    await state.page.getByText('正在检测本机工具并匹配角色…', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(
      await state.page.getByRole('checkbox', { name: '加入 Claude Code 伙伴', exact: true }).isChecked(),
      false,
    );
    await create(state.page).click();
    await state.panel.waitFor({ state: 'hidden' });
    assert.equal(state.writes.length, 2);
    assert.ok(state.writes.every(({ payload }) => payload.clientId === 'acp'));
    assert.deepEqual(state.errors, []);
  } finally {
    await state.context.close();
  }
});

test(
  'partial creation survives reload and retries exactly the failed key and payload',
  { timeout: 30000 },
  async () => {
    const state = await setup({ failCreate: { at: 3, status: 503 } });
    try {
      await create(state.page).click();
      await state.panel.getByRole('alert').waitFor();
      const failed = state.writes[2];
      assert.equal(state.created.length, 2);
      await state.page.reload();
      await state.panel.waitFor();
      await state.page.getByText('正在检测本机工具并匹配角色…', { exact: true }).waitFor({ state: 'hidden' });
      await create(state.page).click();
      await state.panel.waitFor({ state: 'hidden' });
      assert.equal(state.writes.length, 6);
      assert.equal(state.created.length, 5);
      assert.equal(state.writes[3].key, failed.key);
      assert.deepEqual(state.writes[3].payload, failed.payload);
      assert.deepEqual(state.errors, []);
    } finally {
      await state.context.close();
    }
  },
);

test('double click does not create a second batch', { timeout: 30000 }, async () => {
  const state = await setup();
  try {
    await create(state.page).dblclick({ force: true });
    await state.panel.waitFor({ state: 'hidden' });
    assert.equal(state.writes.length, 5);
    assert.equal(new Set(state.writes.map(({ key }) => key)).size, 5);
    assert.deepEqual(state.errors, []);
  } finally {
    await state.context.close();
  }
});

test(
  'a remaining Codex login failure names Codex after Claude is deselected; other selected tools can continue',
  { timeout: 30000 },
  async () => {
    const state = await setup({
      failCreate: { at: 1, status: 400, message: '本机默认号未登录或读不到，请先在官方工具里登录' },
    });
    try {
      await select(state, 29);
      await create(state.page).click();
      const alert = state.panel.getByRole('alert');
      await alert.waitFor();
      assert.match(await alert.innerText(), /Codex.*本机默认号未登录或读不到/s);
      assert.equal(state.writes[0].payload.clientId, 'openai');
      await state.page.getByRole('checkbox', { name: '加入 Codex 伙伴', exact: true }).uncheck();
      await create(state.page).click();
      await state.panel.waitFor({ state: 'hidden' });
      assert.equal(state.created.length, 3);
      assert.equal(state.writes.filter(({ payload }) => payload.clientId === 'anthropic').length, 0);
      assert.equal(state.writes.filter(({ payload }) => payload.clientId === 'openai').length, 1);
      assert.deepEqual(state.errors, []);
    } finally {
      await state.context.close();
    }
  },
);
