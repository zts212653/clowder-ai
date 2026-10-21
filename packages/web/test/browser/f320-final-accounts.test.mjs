import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { runClaudeAccountJourney } from './f320-claude-accounts.journey.mjs';
import { startFinalAccountPreview } from './f320-final-runtime.fixture.mjs';

let preview, browser, companyIdentity;
before(async () => {
  preview = await startFinalAccountPreview({ withOverrides: true, withClaude: true });
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await preview?.close();
});
async function addCodexAccount(page, note) {
  await page.getByRole('button', { name: '+ 添加账号', exact: true }).click();
  await page.getByRole('button', { name: 'Codex · 登录另一个账号', exact: true }).click();
  await page.getByRole('textbox', { name: '账号备注' }).fill(note);
  await page.getByRole('button', { name: '创建并开始登录' }).click();
}
async function readCodexAccount(page, accountRef) {
  const response = await page.request.get(`${preview.url}/api/accounts`, { headers: { 'x-cat-cafe-user': 'fixture' } });
  assert.equal(response.status(), 200, await response.text());
  const account = (await response.json()).providers.find((entry) => entry.id === accountRef);
  assert.ok(account?.codex);
  return account.codex;
}
test(
  'accepted v2 entry keeps native default, adds an independent row, confirms full-local swap, and updates members',
  { timeout: 120000 },
  async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${preview.url}/settings?s=accounts&shell=v2`, { waitUntil: 'domcontentloaded' });
      const list = page.getByRole('group', { name: '账号列表', exact: true });
      const native = page.locator('[data-account-id="codex"]');
      await native.getByText('Codex App 登录（本机默认）', { exact: true }).waitFor();
      await native.getByText('正在用', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '+ 添加账号', exact: true }).count(), 1);
      assert.equal(await native.getByRole('button', { name: '查额度', exact: true }).count(), 0);
      await page.getByRole('button', { name: '+ 添加账号', exact: true }).click();
      await page.getByRole('button', { name: 'Codex · 登录另一个账号', exact: true }).click();
      assert.deepEqual(
        await page
          .getByRole('combobox', { name: '厂商', exact: true })
          .locator('option')
          .evaluateAll((options) => options.map((o) => o.value)),
        ['openai'],
      );
      await page.getByRole('textbox', { name: '账号备注', exact: true }).fill('主号');
      await page.getByRole('button', { name: '创建并开始登录', exact: true }).click();
      const row = list
        .locator('[data-account-id]')
        .filter({ has: page.getByRole('button', { name: '主号', exact: true }) });
      await row.getByText(/终端已打开/).waitFor();
      assert.equal(await row.getByText('正在用', { exact: true }).count(), 0);
      const companyLogin = preview.captureLoginAttempt();
      const failedList = async (route) => {
        const request = route.request();
        if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/accounts')
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'fixture list unavailable' }),
          });
        return route.continue();
      };
      await page.route('**/api/accounts**', failedList);
      await row.getByRole('button', { name: '取消', exact: true }).click();
      await row.getByText('已取消这次登录', { exact: true }).waitFor();
      assert.equal(companyLogin.wasAborted(), true);
      await row.getByRole('button', { name: '重试', exact: true }).click();
      await row.getByText(/终端已打开/).waitFor();
      await page.unroute('**/api/accounts**', failedList);
      companyIdentity = await preview.captureLoginAttempt().complete();
      await row.getByText('已登录', { exact: true }).waitFor();
      await row.getByRole('button', { name: '换成这个', exact: true }).waitFor();
      assert.equal(await row.getByText('正在用', { exact: true }).count(), 0);
      const ref = await row.getAttribute('data-account-id');
      await row.getByRole('button', { name: '主号', exact: true }).click();
      const details = page.locator(`#account-row-${encodeURIComponent(ref)} + .account-expanded`);
      await row.getByRole('button', { name: '查额度', exact: true }).click();
      await row.getByText(/剩 70%/).waitFor();
      assert.equal(await details.getByRole('meter').count(), 0);
      const before = await preview.reply('fixture original account');
      assert.equal(before.accountRef, 'codex');
      await row.getByRole('button', { name: '换成这个', exact: true }).click();
      const confirm = page.getByRole('region', { name: '换号确认' });
      await confirm.getByText('会跟着换的 1 只：', { exact: true }).waitFor();
      await confirm.getByText(/例外公司号/).waitFor();
      await confirm.getByRole('checkbox', { name: '也一起换' }).check();
      await confirm.getByText('会跟着换的 2 只：', { exact: true }).waitFor();
      assert.equal(await confirm.getByText(/现在用别的号的/).count(), 0);
      await confirm.getByRole('checkbox', { name: '也一起换' }).uncheck();
      await confirm.getByText('会跟着换的 1 只：', { exact: true }).waitFor();
      await confirm.getByRole('checkbox', { name: '也一起换' }).check();
      await confirm.getByText('会跟着换的 2 只：', { exact: true }).waitFor();
      await confirm.getByRole('button', { name: '确认换号', exact: true }).click();
      await row.getByText('正在用', { exact: true }).waitFor();
      const after = await preview.reply('fixture selected account');
      assert.equal(after.accountRef, ref);
      assert.equal(await native.getByText('正在用', { exact: true }).count(), 0);
      if (process.env.F320_EVIDENCE_DIR) {
        await mkdir(process.env.F320_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.F320_EVIDENCE_DIR, 'accounts-v2-desktop.png'), fullPage: true });
      }
      await page.reload();
      await row.getByText('正在用', { exact: true }).waitFor();
      await page.getByRole('searchbox', { name: '搜索账户或成员' }).fill('codex61-sol');
      assert.equal(await list.locator('[data-account-id]').count(), 1);
      await page.getByRole('searchbox', { name: '搜索账户或成员' }).fill('');
      await page.goto(`${preview.url}/settings?s=members&shell=v2`, { waitUntil: 'domcontentloaded' });
      const member = page.getByTestId('member-account-codex61-sol');
      // The accepted member table gives account names their own column; the header supplies the meaning.
      await page.getByRole('columnheader', { name: '账号', exact: true }).waitFor();
      await member.getByText('主号', { exact: true }).waitFor();
      const memberRow = page.locator('tr[data-cat-id="codex61-sol"]');
      const columns = await page.locator('.member-table th').allTextContents();
      assert.equal(await memberRow.locator('td').nth(columns.indexOf('账号')).innerText(), '主号');
      assert.equal(await member.getByRole('button').count(), 0);
      if (process.env.F320_EVIDENCE_DIR)
        await page.screenshot({
          path: join(process.env.F320_EVIDENCE_DIR, 'members-selected-account-column.png'),
          fullPage: true,
        });
      await page.goto(`${preview.url}/settings?s=accounts&shell=v2`, { waitUntil: 'domcontentloaded' });
      // Seed the real theme owner in this fresh fixture context; ThemeApplier renders its palette.
      await page.evaluate(() => {
        localStorage.setItem('cat-cafe:themes', JSON.stringify({ activeId: 'dark', custom: [], builtInOverrides: {} }));
        localStorage.setItem('theme', 'dark');
      });
      await page.goto(`${preview.url}/settings?s=accounts&shell=v2`, { waitUntil: 'domcontentloaded' });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
      await row.scrollIntoViewIfNeeded();
      await row.getByText('正在用', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (process.env.F320_EVIDENCE_DIR)
        await page.screenshot({
          path: join(process.env.F320_EVIDENCE_DIR, 'accounts-v2-mobile-dark.png'),
          fullPage: true,
        });
      if (process.env.F320_EVIDENCE_DIR)
        await writeFile(
          join(process.env.F320_EVIDENCE_DIR, 'journey.json'),
          JSON.stringify(
            {
              worktree: new URL('../../../../', import.meta.url).pathname,
              webUrl: preview.url,
              apiUrl: preview.apiUrl,
              route: '/settings?s=accounts&shell=v2',
              realOAuth: false,
              selectedAccountRef: ref,
              theme: await page.evaluate(() => document.documentElement.getAttribute('data-theme')),
              viewport: page.viewportSize(),
              actions: [
                'create',
                'cancel',
                'retry',
                'fixture-login',
                'quota-fixture',
                'local-preview',
                'confirm',
                'reload',
                'search-cat',
                'member-account-name',
              ],
              errors,
            },
            null,
            2,
          ),
        );
      assert.deepEqual(errors, []);
    } catch (error) {
      if (process.env.F320_EVIDENCE_DIR) {
        await mkdir(process.env.F320_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.F320_EVIDENCE_DIR, 'accounts-v2-failure.png'), fullPage: true });
      }
      console.log('fixture visible page:', (await page.locator('body').innerText()).slice(-2200));
      throw error;
    } finally {
      await page.close();
    }
  },
);

test(
  'mobile cancel and retry fence the actual late driver result on the same v2 row',
  { timeout: 120000 },
  async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.goto(`${preview.url}/settings?s=accounts&shell=v2`, { waitUntil: 'domcontentloaded' });
      await addCodexAccount(page, '私人');
      const row = page
        .locator('[data-account-id]')
        .filter({ has: page.getByRole('button', { name: '私人', exact: true }) });
      await row.getByText(/终端已打开/).waitFor();
      const cancelledLogin = preview.captureLoginAttempt();
      cancelledLogin.keepPendingAfterAbort();
      const ref = await row.getAttribute('data-account-id');
      const original = await readCodexAccount(page, ref);
      await row.getByRole('button', { name: '取消', exact: true }).click();
      await row.getByText('已取消这次登录', { exact: true }).waitFor();
      assert.equal(cancelledLogin.wasAborted(), true);
      await row.getByRole('button', { name: '重试', exact: true }).click();
      await row.getByText('正在准备官方终端登录', { exact: true }).waitFor();
      const queued = await readCodexAccount(page, ref);
      assert.equal(queued.attempt.state, 'queued');
      assert.notEqual(queued.attempt.id, original.attempt.id);
      assert.equal(queued.attempt.identity, undefined);
      const lateIdentity = await cancelledLogin.complete();
      await row.getByText(/终端已打开/).waitFor();
      const retry = preview.captureLoginAttempt();
      const waiting = await readCodexAccount(page, ref);
      assert.equal(waiting.attempt.id, queued.attempt.id);
      assert.equal(waiting.attempt.state, 'waiting');
      assert.equal(waiting.attempt.identity, undefined);
      assert.equal(waiting.identity, undefined);
      assert.ok(!(await row.innerText()).includes(lateIdentity.email));
      assert.equal(await row.getAttribute('data-account-id'), ref);
      const identity = await retry.complete();
      await row.getByText(identity.email, { exact: true }).waitFor();
      assert.notEqual(identity.email, lateIdentity.email);
      assert.ok(!(await row.innerText()).includes(lateIdentity.email));
      const box = await row.boundingBox();
      assert.ok(box && box.width <= 390);
      await row.getByLabel('私人更多操作', { exact: true }).click();
      await row.getByRole('button', { name: '删除登记', exact: true }).click();
      await page.getByText(/只删这里的登记，不会注销官方账号/).waitFor();
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await row.getByRole('button', { name: '删除登记', exact: true }).click();
      await page.getByRole('button', { name: '删除登记', exact: true }).last().click();
      await row.waitFor({ state: 'detached' });
    } finally {
      await page.close();
    }
  },
);
test(
  'duplicate identity explicitly deletes its surplus row and returns to the existing selected account',
  { timeout: 120000 },
  async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${preview.url}/settings?s=accounts&shell=v2`, { waitUntil: 'domcontentloaded' });
      const existing = page
        .locator('[data-account-id]')
        .filter({ has: page.getByRole('button', { name: '主号', exact: true }) });
      await existing.getByText('正在用', { exact: true }).waitFor();
      const ref = await existing.getAttribute('data-account-id');
      await addCodexAccount(page, '重复主号');
      const row = page
        .locator('[data-account-id]')
        .filter({ has: page.getByRole('button', { name: '重复主号', exact: true }) });
      await row.getByText(/终端已打开/).waitFor();
      assert.ok(companyIdentity);
      await preview.captureLoginAttempt().complete(companyIdentity);
      await row.getByRole('button', { name: '去处理', exact: true }).click();
      const extraRef = await row.getAttribute('data-account-id');
      const details = page.locator(`#account-row-${encodeURIComponent(extraRef)} + .account-expanded`);
      await details.getByText(/登录的是列表里已有的「主号」/).waitFor();
      await details.getByRole('button', { name: '删掉这条，回到主号', exact: true }).click();
      await row.waitFor({ state: 'detached' });
      await existing.getByText('正在用', { exact: true }).waitFor();
      await page.reload({ waitUntil: 'domcontentloaded' });
      assert.equal(await page.getByRole('button', { name: '重复主号', exact: true }).count(), 0);
      await existing.getByText('已登录', { exact: true }).waitFor();
      assert.equal((await preview.reply('fixture after explicit duplicate removal')).accountRef, ref);
    } finally {
      await page.close();
    }
  },
);

test(
  'Claude account entry keeps secrets private, switches next calls, preserves in-flight metadata and recovers token errors',
  { timeout: 120000 },
  () => runClaudeAccountJourney({ preview, browser }),
);
