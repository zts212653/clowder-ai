import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { create, evidence, ids, runtimes, select, setup } from './native-team-setup.harness.mjs';

for (let mask = 0; mask < 32; mask++) {
  test(
    `selection mask ${mask}: only selected tools are submitted, including zero and every singleton`,
    { timeout: 30000 },
    async () => {
      const state = await setup();
      try {
        await select(state, mask);
        const count = ids.filter((_, i) => mask & (1 << i)).length;
        if (!count) {
          assert.equal(await create(state.page).count(), 0);
          assert.ok(await state.page.getByRole('button', { name: '暂不创建', exact: true }).isEnabled());
          await state.page.getByRole('button', { name: '暂不创建', exact: true }).click();
          await state.panel.waitFor({ state: 'hidden' });
          assert.equal(state.writes.length, 0);
        } else {
          await create(state.page).click();
          await state.panel.waitFor({ state: 'hidden' });
          assert.equal(state.writes.length, count);
          const expected = ids.filter((_, i) => mask & (1 << i));
          const submitted = state.writes.map(({ payload }) => {
            // User-facing identities can change; the submitted launch config
            // must still match the selected discovered tool exactly.
            const runtime = runtimes.find(
              (runtime) =>
                runtime.clientId === payload.clientId &&
                (runtime.clientId !== 'acp' ||
                  isDeepStrictEqual({ transport: 'stdio', ...runtime.acp }, { transport: 'stdio', ...payload.acp })),
            );
            assert.ok(runtime, 'creation must preserve a discovered runtime launch config');
            return runtime.id;
          });
          assert.deepEqual(submitted, expected);
        }
        assert.deepEqual(state.errors, []);
      } finally {
        await state.context.close();
      }
    },
  );
}

for (const status of [400, 403, 409, 429, 500, 503]) {
  test(
    `HTTP ${status}: partial creation names the failed partner; retry keeps receipts and skips completed partners`,
    { timeout: 30000 },
    async () => {
      const state = await setup({ failCreate: { at: 2, status } });
      try {
        await create(state.page).click();
        const alert = state.panel.getByRole('alert');
        await alert.waitFor();
        assert.match(await alert.innerText(), /Claude Code.*fixture account unavailable/s);
        assert.equal(state.created.length, 1);
        const failed = state.writes[1];
        await create(state.page).click();
        await state.panel.waitFor({ state: 'hidden' });
        assert.equal(state.created.length, 5);
        assert.equal(state.writes.length, 6);
        assert.equal(state.writes[2].key, failed.key);
        assert.deepEqual(state.writes[2].payload, failed.payload);
        assert.deepEqual(state.errors, []);
      } finally {
        await state.context.close();
      }
    },
  );
}

test(
  'HTTP 401 refreshes the real session and automatically replays the same creation receipt once',
  { timeout: 30000 },
  async () => {
    const state = await setup({ failCreate: { at: 2, status: 401 } });
    try {
      await create(state.page).click();
      await state.panel.waitFor({ state: 'hidden' });
      assert.equal(state.created.length, 5);
      assert.equal(state.writes.length, 6);
      assert.equal(state.writes[2].key, state.writes[1].key);
      assert.deepEqual(state.writes[2].payload, state.writes[1].payload);
      assert.deepEqual(state.errors, []);
    } finally {
      await state.context.close();
    }
  },
);

test(
  'discovery failure is distinct from no clients; refresh recovers and later detects a newly started DSH',
  { timeout: 30000 },
  async () => {
    const state = await setup({ discoveryFails: true });
    try {
      assert.match(await state.panel.innerText(), /暂时无法检测工具/);
      await state.page.screenshot({ path: path.join(evidence, 'discovery-unavailable.png'), fullPage: true });
      state.recoverDiscovery();
      state.discover(runtimes.map((r) => ({ ...r, installed: false })));
      await state.page.getByRole('button', { name: '重新检测', exact: true }).click();
      await state.page.getByText('还没有找到可加入的工具', { exact: true }).waitFor();
      assert.equal(await create(state.page).count(), 0);
      assert.ok(await state.page.getByRole('button', { name: '手动创建单个伙伴', exact: true }).isEnabled());
      await state.page.screenshot({ path: path.join(evidence, 'no-client-manual-fallback.png'), fullPage: true });
      state.discover(runtimes);
      await state.page.getByRole('button', { name: '重新检测', exact: true }).click();
      await state.page.getByText('推荐伙伴 · 5 位', { exact: true }).waitFor();
      assert.ok(await state.page.getByRole('checkbox', { name: '加入 DSH 伙伴', exact: true }).isEnabled());
      await state.page.screenshot({ path: path.join(evidence, 'five-partners.png'), fullPage: true });
      for (const label of ['DSH', 'Pi']) {
        const image = state.page
          .locator('article')
          .filter({ has: state.page.getByRole('checkbox', { name: `加入 ${label} 伙伴`, exact: true }) })
          .locator('img');
        assert.ok(await image.evaluate((img) => img.complete && img.naturalWidth > 0));
      }
      assert.deepEqual(state.errors, []);
    } finally {
      await state.context.close();
    }
  },
);

test('manual creation remains available from the automatic configuration path', { timeout: 30000 }, async () => {
  const state = await setup();
  try {
    assert.equal(
      state.requests.some(({ path }) => path === '/api/agent-providers'),
      false,
    );
    let catalogReads = 0;
    // Only the ordinary editor reached below consumes the plugin tool catalog.
    // Other first-run cases keep rejecting this unmodeled dependency.
    await state.context.route('**/api/agent-providers', (route) => {
      assert.equal(route.request().method(), 'GET');
      catalogReads++;
      return route.fulfill({ json: { libraries: [] } });
    });
    const catalogRead = state.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/agent-providers' && response.request().method() === 'GET',
    );
    await state.page.getByRole('button', { name: '手动创建单个伙伴', exact: true }).click();
    await state.panel.waitFor({ state: 'hidden' });
    await state.page.waitForURL((url) => url.searchParams.get('manual') === '1');
    await catalogRead;
    assert.equal(catalogReads, 1);
    assert.equal(new URL(state.page.url()).searchParams.get('manual'), '1');
    assert.equal(state.writes.length, 0);
    assert.deepEqual(state.errors, []);
  } finally {
    await state.context.close();
  }
});
