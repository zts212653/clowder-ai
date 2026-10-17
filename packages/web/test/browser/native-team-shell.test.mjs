import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { evidence, setup } from './native-team-setup.harness.mjs';

for (const shell of ['classic', 'v2']) {
  test(
    `${shell}: manual fallback and collaboration demo keep the user's shell preference`,
    { timeout: 40000 },
    async () => {
      const state = await setup({ shell });
      const { page } = state;
      const checkShell = async () => {
        await page.waitForFunction(
          (expected) =>
            expected === 'v2'
              ? document.documentElement.dataset.shell === 'v2'
              : !document.documentElement.dataset.shell,
          shell,
        );
        assert.equal(await page.evaluate(() => localStorage.getItem('cat-cafe:shell-presentation')), shell);
      };
      try {
        await checkShell();
        await page.getByRole('button', { name: '手动创建单个伙伴', exact: true }).click();
        await page.waitForURL((url) => url.searchParams.get('manual') === '1');
        await checkShell();
        await page.goto(new URL('/?lang=zh', process.env.CAT_CAFE_ONBOARDING_E2E_URL).href);
        const demo = page.getByRole('dialog').filter({ has: page.getByTestId('demo-transcript') });
        if (!(await demo.isVisible())) {
          try {
            await page.getByRole('button', { name: '看看团队如何协作', exact: true }).click({ timeout: 5000 });
          } catch (error) {
            if (!(await demo.isVisible())) throw error;
          }
        }
        await demo.waitFor();
        await demo.getByRole('button', { name: '暂停', exact: true }).waitFor();
        await demo.getByRole('link', { name: /创建我的猫猫/ }).click();
        await state.panel.waitFor();
        await checkShell();
        await page.screenshot({ path: path.join(evidence, `shell-${shell}-retained.png`), fullPage: true });
        assert.equal(state.writes.length, 0, 'Navigation and mock playback never create real roles');
        assert.deepEqual(state.errors, []);
      } finally {
        await state.context.close();
      }
    },
  );
}
