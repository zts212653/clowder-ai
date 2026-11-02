import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const tokens = ['sk-ant-oat01-fixture-company', 'sk-ant-oat01-fixture-personal'];
/** Claude coverage belongs to the admitted F320 account journey and uses its isolated preview. */
export async function runClaudeAccountJourney({ preview, browser }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${preview.url}/settings?s=accounts&shell=v2`, { waitUntil: 'domcontentloaded' });
    const native = page.locator('[data-account-id="claude"]');
    await native.getByText('正在用', { exact: true }).waitFor();
    async function add(note, token) {
      await page.getByRole('button', { name: '+ 添加账号', exact: true }).click();
      await page.getByRole('button', { name: 'Claude · 添加长效 token', exact: true }).click();
      const form = page.getByRole('dialog', { name: 'Claude 长效 token 账号' });
      await form.getByRole('textbox', { name: '账号备注', exact: true }).fill(note);
      await form.getByLabel('长效 token', { exact: true }).fill(token);
      assert.equal(await form.getByLabel('长效 token', { exact: true }).getAttribute('type'), 'password');
      await form.getByRole('button', { name: '保存 token', exact: true }).click();
      return form;
    }
    const bad = await add('公司', 'fixture-malformed-secret');
    await bad.getByRole('alert').waitFor();
    assert.ok(!(await page.locator('body').innerText()).includes('fixture-malformed-secret'));
    await bad.getByLabel('长效 token', { exact: true }).fill(tokens[0]);
    await bad.getByRole('button', { name: '保存 token', exact: true }).click();
    await bad.waitFor({ state: 'hidden' });
    const a = page
      .locator('[data-account-id]')
      .filter({ has: page.getByRole('button', { name: '公司', exact: true }) });
    await a.getByText('Token 已保存', { exact: true }).waitFor();
    const ar = await a.getAttribute('data-account-id');
    await add('私人', tokens[1]);
    let b = page.locator('[data-account-id]').filter({ has: page.getByRole('button', { name: '私人', exact: true }) });
    await b.getByText('Token 已保存', { exact: true }).waitFor();
    const br = await b.getAttribute('data-account-id');
    b = page.locator(`[data-account-id="${br}"]`);
    assert.equal(await a.getByText('正在用', { exact: true }).count(), 0);
    async function select(row) {
      await row.getByRole('button', { name: '换成这个', exact: true }).click();
      const region = page.getByRole('region', { name: '换号确认' });
      await region.getByText('会跟着换的 2 只：', { exact: true }).waitFor();
      await region.getByRole('button', { name: '确认换号', exact: true }).click();
      await row.getByText('正在用', { exact: true }).waitFor();
    }
    await select(a);
    let release, started;
    const done = new Promise((r) => (release = r));
    const launch = new Promise((r) => (started = r));
    const inFlight = preview.reply('in flight with A', 'opus', done, started);
    await launch;
    await select(b);
    release();
    const old = await inFlight;
    assert.equal(old.accountRef, ar);
    const next = await preview.reply('next call with B', 'opus');
    assert.equal(next.accountRef, br);
    const responses = await page.request.get(`${preview.apiUrl}/api/messages`);
    const messages = (await responses.json()).messages.filter((message) => message.catId === 'opus');
    assert.equal(messages[0].metadata.usage.executionAccount.accountRef, ar);
    assert.equal(messages[1].metadata.usage.executionAccount.accountRef, br);
    const list = await page.request.get(`${preview.apiUrl}/api/accounts`);
    const json = await list.text();
    for (const token of tokens) assert.ok(!json.includes(token));
    const stored = await readFile(join(preview.root, '.cat-cafe/credentials.json'), 'utf8');
    for (const token of tokens) assert.ok(stored.includes(token));
    await page.reload();
    await b.getByText('正在用', { exact: true }).waitFor();
    const evidence = process.env.F320_EVIDENCE_DIR;
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, 'claude-accounts-desktop.png'), fullPage: true });
    }
    await b.getByRole('button', { name: '私人', exact: true }).click();
    const expanded = page.locator(`#account-row-${encodeURIComponent(br)} + .account-expanded`);
    await expanded
      .getByText('身份、到期时间与额度未验证；本地 MCP 可用，claude.ai connectors 与 Remote Control 不可用。', {
        exact: true,
      })
      .waitFor();
    await b.getByLabel('私人更多操作').click();
    await b.getByRole('button', { name: '更新 token', exact: true }).click();
    const update = page.getByRole('dialog');
    await update.getByLabel('账号备注', { exact: true }).fill('私人备用');
    assert.equal(await update.getByLabel('长效 token', { exact: true }).inputValue(), '');
    await update.getByRole('button', { name: '保存更改', exact: true }).click();
    await update.waitFor({ state: 'hidden' });
    const credentials = JSON.parse(await readFile(join(preview.root, '.cat-cafe/credentials.json'), 'utf8'));
    assert.equal(credentials[br].accessToken, tokens[1]);
    if ((await b.locator('details.account-menu').getAttribute('open')) === null)
      await b.getByLabel('私人备用更多操作').click();
    await b.getByRole('button', { name: '更新 token', exact: true }).click();
    await update.getByLabel('长效 token', { exact: true }).fill(tokens[0]);
    await update.getByRole('button', { name: '保存更改', exact: true }).click();
    await update.waitFor({ state: 'hidden' });
    await select(native);
    assert.equal((await preview.reply('back to default', 'opus')).accountRef, 'claude');
    const nativeReplies = await (await page.request.get(`${preview.apiUrl}/api/messages`)).json();
    assert.equal(nativeReplies.messages.at(-1).metadata.usage.executionAccount.accountRef, 'claude');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.evaluate(() => {
      localStorage.setItem('cat-cafe:shell-language', 'en');
      localStorage.setItem('theme', 'dark');
      localStorage.setItem('cat-cafe:themes', JSON.stringify({ activeId: 'dark', custom: [], builtInOverrides: {} }));
    });
    await page.reload();
    await page.getByRole('button', { name: '+ Add account', exact: true }).waitFor();
    await page.getByRole('button', { name: '+ Add account', exact: true }).click();
    await page.getByRole('button', { name: 'Claude · Add a long-lived token', exact: true }).click();
    const enForm = page.getByRole('dialog', { name: 'Claude token account' });
    await enForm.getByLabel('Account note', { exact: true }).fill('test');
    if (evidence) await page.screenshot({ path: join(evidence, 'claude-token-mobile-dark-en.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await enForm.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}
