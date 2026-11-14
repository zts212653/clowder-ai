import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
export function registerAgyAccountJourney(options) {
  test(
    'AGY accounts use the existing directory, explicit switch and persisted member binding',
    { timeout: 120000 },
    async () => {
      const preview = options.preview();
      const browser = options.browser();
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const evidence = process.env.F320_AGY_EVIDENCE_DIR;
      try {
        await page.goto(`${preview.url}/settings?s=accounts&shell=v2`, { waitUntil: 'domcontentloaded' });
        await page.getByRole('button', { name: '+ 添加账号', exact: true }).click();
        await page.getByRole('button', { name: 'AGY · Google OAuth', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'AGY · Google OAuth', exact: true });
        await dialog.getByRole('textbox', { name: '账号备注', exact: true }).fill('AGY 公司号');
        await dialog.getByRole('button', { name: '保存账号', exact: true }).click();
        await dialog.getByRole('textbox', { name: '官方登录命令', exact: true }).waitFor();
        const command = await dialog.getByRole('textbox', { name: '官方登录命令', exact: true }).inputValue();
        assert.match(command, /agy:account:login/);
        const response = await page.request.get(`${preview.apiUrl}/api/accounts`, {
          headers: { 'x-cat-cafe-user': 'fixture' },
        });
        const account = (await response.json()).providers.find((row) => row.displayName === 'AGY 公司号');
        assert.equal(account.agyLoginStatus, 'not_logged_in');
        const membersBefore = await page.request.get(`${preview.apiUrl}/api/accounts/agy/members`, {
          headers: { 'x-cat-cafe-user': 'fixture' },
        });
        assert.equal((await membersBefore.json()).selection.members[0].accountRef, 'gemini');
        // A synthetic CLI-owned login file. No browser authorization, real token or Google call.
        await writeFile(
          join(account.agy.credentialHome, '.gemini/antigravity-cli/antigravity-oauth-token'),
          JSON.stringify({
            auth_method: 'consumer',
            token: {
              access_token: 'fixture',
              refresh_token: 'fixture-refresh',
              expiry: '2000-01-01T00:00:00Z',
            },
          }),
          { mode: 0o600 },
        );
        await dialog.getByRole('button', { name: '刷新登录状态', exact: true }).click();
        await dialog.getByText('登录文件已就绪。现在可以在账号列表点「换成这个」。', { exact: true }).waitFor();
        if (evidence) {
          await mkdir(evidence, { recursive: true });
          await page.screenshot({ path: join(evidence, 'agy-login-desktop.png') });
        }
        await dialog.getByRole('button', { name: '关闭', exact: true }).click();
        const row = page.locator(`[data-account-id="${account.id}"]`);
        const planned = page.waitForResponse((response) => response.url().endsWith('/agy/binding/preview'));
        await row.getByRole('button', { name: '换成这个', exact: true }).click();
        const plan = await (await planned).json();
        assert.deepEqual(
          plan.targets.map((target) => target.catId),
          ['gemini38'],
        );
        const confirmation = page.getByRole('region', { name: '换号确认' });
        await confirmation.getByText(plan.targets[0].name, { exact: true }).waitFor();
        let releaseOld;
        let markStarted;
        const oldWork = new Promise((resolve) => {
          releaseOld = resolve;
        });
        const started = new Promise((resolve) => {
          markStarted = resolve;
        });
        const inFlight = preview.reply('frozen old AGY selection', 'gemini38', oldWork, () => markStarted());
        await started;
        try {
          await confirmation.getByRole('button', { name: '确认换号', exact: true }).click();
          await row.getByText('正在用', { exact: true }).waitFor();
        } finally {
          releaseOld();
        }
        assert.equal((await inFlight).accountRef, 'gemini');
        assert.equal((await preview.reply('synthetic account attribution', 'gemini38')).accountRef, account.id);
        await page.reload();
        await row.getByText('正在用', { exact: true }).waitFor();
        if (evidence) await page.screenshot({ path: join(evidence, 'agy-selected-desktop.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await row.getByRole('button', { name: 'AGY 公司号', exact: true }).click();
        if (evidence) await page.screenshot({ path: join(evidence, 'agy-selected-mobile.png'), fullPage: true });
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    },
  );
}
