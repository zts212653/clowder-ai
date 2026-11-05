import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create, setup } from './native-team-setup.harness.mjs';

test('deselect the failed Claude and continue without submitting it again', { timeout: 30000 }, async () => {
  const state = await setup({ failCreate: { at: 2, status: 403 } });
  try {
    await create(state.page).click();
    await state.panel.getByRole('alert').waitFor();
    await state.page.getByRole('checkbox', { name: '加入 Claude Code 伙伴', exact: true }).uncheck();
    await create(state.page).click();
    await state.panel.waitFor({ state: 'hidden' });
    assert.equal(state.created.length, 4);
    assert.equal(state.writes.filter(({ payload }) => payload.clientId === 'anthropic').length, 1);
    assert.deepEqual(state.errors, []);
  } finally {
    await state.context.close();
  }
});

for (const committed of [false, true]) {
  test(
    `connection loss ${committed ? 'after' : 'before'} commit: same key replay creates no duplicates`,
    { timeout: 30000 },
    async () => {
      const state = await setup({ failCreate: { at: 3, disconnect: true, committed } });
      try {
        await create(state.page).click();
        await state.panel.getByRole('alert').waitFor();
        assert.equal(state.created.length, committed ? 3 : 2);
        const failed = state.writes[2];
        await state.page.reload();
        await state.panel.waitFor();
        await state.page.getByText('正在检测本机工具并匹配角色…', { exact: true }).waitFor({ state: 'hidden' });
        await create(state.page).click();
        await state.panel.waitFor({ state: 'hidden' });
        assert.equal(state.created.length, 5);
        assert.equal(state.writes[3].key, failed.key);
        assert.deepEqual(state.writes[3].payload, failed.payload);
        assert.equal(new Set(state.created.map((c) => c.id)).size, 5);
        assert.deepEqual(state.errors, []);
      } finally {
        await state.context.close();
      }
    },
  );
}

test(
  'a nonresponding creation times out, releases the button and preserves the retry key',
  { timeout: 50000 },
  async () => {
    const state = await setup({ failCreate: { at: 2, hang: true } });
    try {
      const started = Date.now();
      await create(state.page).click();
      await state.panel.getByRole('alert').waitFor({ timeout: 38000 });
      assert.ok(Date.now() - started < 38000, 'The UI must not wait indefinitely');
      assert.ok(await create(state.page).isEnabled());
      assert.equal(state.created.length, 1);
      const failed = state.writes[1];
      await create(state.page).click();
      await state.panel.waitFor({ state: 'hidden' });
      assert.equal(state.created.length, 5);
      assert.equal(state.writes[2].key, failed.key);
      assert.deepEqual(state.writes[2].payload, failed.payload);
      assert.deepEqual(state.errors, []);
    } finally {
      await state.context.close();
    }
  },
);
