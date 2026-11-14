import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { startFinalAccountPreview } from './f320-final-runtime.fixture.mjs';

let preview, browser;
before(async () => {
  preview = await startFinalAccountPreview();
  const path = join(preview.root, '.cat-cafe/accounts.json');
  const accounts = JSON.parse(await readFile(path, 'utf8'));
  accounts.gemini = { authType: 'oauth', clientId: 'google', displayName: 'Gemini 登录 fixture' };
  accounts.claude = { authType: 'oauth', clientId: 'anthropic', displayName: 'Claude 登录 fixture' };
  accounts['existing-anthropic'] = {
    authType: 'api_key',
    clientId: 'anthropic',
    displayName: '已有 Anthropic fixture',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-fixture'],
  };
  await writeFile(
    join(preview.root, '.cat-cafe/credentials.json'),
    JSON.stringify({ 'existing-anthropic': { apiKey: 'FAKE_OLD_KEY' } }),
  );
  await writeFile(path, JSON.stringify(accounts));
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await preview?.close();
});
test(
  'OpenAI, Google and Anthropic keys save without models, while existing keys and OAuth stay intact',
  { timeout: 120000 },
  async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors = [];
    const logins = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (/\/(codex|claude)\/login\//.test(request.url())) logins.push(request.url());
    });
    const screenshot = async (name) => {
      if (!process.env.F317_PLATFORM_EVIDENCE_DIR) return;
      await mkdir(process.env.F317_PLATFORM_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.F317_PLATFORM_EVIDENCE_DIR, name), fullPage: true });
    };
    try {
      await page.goto(`${preview.url}/settings?s=accounts&shell=v2`, { waitUntil: 'domcontentloaded' });
      const native = page.locator('[data-account-id="codex"]');
      await native.getByText('正在用', { exact: true }).waitFor();
      await page.getByRole('button', { name: '+ 添加账号', exact: true }).click();
      await page.getByRole('button', { name: '填一个 API 密钥', exact: true }).click();
      const provider = page.getByRole('combobox', { name: 'API Key 归属', exact: true });
      await provider.selectOption('openai');
      assert.equal(await provider.locator('option:checked').textContent(), 'OpenAI Platform');
      await page.getByRole('textbox', { name: '账号名称', exact: true }).fill('共用 Platform');
      assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isDisabled(), true);
      await page.getByLabel('API Key', { exact: true }).fill('FAKE_PLATFORM_KEY');
      assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isEnabled(), true);
      await screenshot('platform-create-desktop.png');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      const row = page.locator('[data-account-id]').filter({ hasText: '共用 Platform' });
      await row.getByText('密钥已填', { exact: true }).waitFor();
      const response = await page.request.get(`${preview.url}/api/accounts`);
      const account = (await response.json()).providers.find((item) => item.displayName === '共用 Platform');
      assert.equal(account.clientId, 'openai');
      assert.equal(account.authType, 'api_key');
      assert.equal(account.hasApiKey, true);
      assert.ok(!account.models?.length);
      assert.ok(!account.baseUrl);
      await page.reload();
      await row.getByText('OpenAI Platform', { exact: true }).waitFor();
      await native.getByText('正在用', { exact: true }).waitFor();
      await screenshot('platform-saved-desktop.png');
      await row.getByLabel('共用 Platform更多操作', { exact: true }).click();
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      await page.getByRole('textbox', { name: '账号名称', exact: true }).fill('共用 Platform 更新');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      await screenshot('platform-edit-mobile-dark.png');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByText('共用 Platform 更新', { exact: true }).waitFor();
      await page.setViewportSize({ width: 1440, height: 1050 });
      await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
      await page.getByRole('button', { name: '+ 添加账号', exact: true }).click();
      await page.getByRole('button', { name: '填一个 API 密钥', exact: true }).click();
      const googleProvider = page.getByRole('combobox', { name: 'API Key 归属', exact: true });
      await googleProvider.selectOption('google');
      assert.equal(await googleProvider.locator('option:checked').textContent(), 'Google API');
      await page.getByRole('textbox', { name: '账号名称', exact: true }).fill('共用 Google');
      await page.getByLabel('API Key', { exact: true }).fill('FAKE_GOOGLE_KEY');
      await page
        .getByText(
          '留空使用 Vertex AI（https://aiplatform.googleapis.com，按 Google Cloud 结算账号计费）。请填 Vertex 可用的 key，AI Studio 的 key 不能用。',
          {
            exact: true,
          },
        )
        .waitFor();
      assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isEnabled(), true);
      await screenshot('google-platform-create-desktop.png');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.reload();
      const googleRow = page.locator('[data-account-id]').filter({ hasText: '共用 Google' });
      await googleRow.getByText('Google API', { exact: true }).waitFor();
      await googleRow.getByText('密钥已填', { exact: true }).waitFor();
      await page.locator('[data-account-id="gemini"]').getByText('Gemini', { exact: true }).waitFor();
      await native.getByText('正在用', { exact: true }).waitFor();
      const googleAccounts = (await (await page.request.get(`${preview.url}/api/accounts`)).json()).providers;
      const googleAccount = googleAccounts.find((item) => item.displayName === '共用 Google');
      assert.equal(googleAccount.clientId, 'google');
      assert.equal(googleAccount.authType, 'api_key');
      assert.ok(!googleAccount.baseUrl && !googleAccount.models?.length);
      assert.equal(googleAccounts.find((item) => item.id === 'gemini').authType, 'oauth');
      await screenshot('platforms-saved-desktop.png');
      await page.getByRole('button', { name: '+ 添加账号', exact: true }).click();
      await page.getByRole('button', { name: '填一个 API 密钥', exact: true }).click();
      await page.getByRole('combobox', { name: 'API Key 归属', exact: true }).selectOption('anthropic');
      await page.getByRole('textbox', { name: '账号名称', exact: true }).fill('共用 Anthropic');
      await page.getByLabel('API Key', { exact: true }).fill('FAKE_ANTHROPIC_KEY');
      await page
        .getByText('留空使用 https://api.anthropic.com。此账号可供多个 Anthropic 能力共用。', { exact: true })
        .waitFor();
      assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isEnabled(), true);
      await screenshot('anthropic-platform-create-desktop.png');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      const anthropicRow = page.locator('[data-account-id]').filter({ hasText: '共用 Anthropic' });
      await anthropicRow.getByText('密钥已填', { exact: true }).waitFor();
      await page.reload();
      await anthropicRow.getByText('Anthropic API', { exact: true }).waitFor();
      await page.locator('[data-account-id="claude"]').getByText('Claude', { exact: true }).waitFor();
      const existing = page.locator('[data-account-id="existing-anthropic"]');
      await existing.getByLabel('已有 Anthropic fixture更多操作', { exact: true }).click();
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByRole('textbox', { name: '账号名称', exact: true }).waitFor({ state: 'hidden' });
      await existing.getByText('密钥已填', { exact: true }).waitFor();
      const all = (await (await page.request.get(`${preview.url}/api/accounts`)).json()).providers;
      const anthropic = all.find((item) => item.displayName === '共用 Anthropic');
      assert.ok(!anthropic.baseUrl && !anthropic.models?.length);
      assert.equal(anthropic.clientId, 'anthropic');
      assert.equal(all.find((item) => item.id === 'claude').authType, 'oauth');
      const old = all.find((item) => item.id === 'existing-anthropic');
      assert.equal(old.baseUrl, 'https://api.anthropic.com');
      assert.deepEqual(old.models, ['claude-fixture']);
      const keys = JSON.parse(await readFile(join(preview.root, '.cat-cafe/credentials.json'), 'utf8'));
      assert.equal(keys['existing-anthropic'].apiKey, 'FAKE_OLD_KEY');
      await native.getByText('正在用', { exact: true }).waitFor();
      await screenshot('all-platforms-saved-desktop.png');
      assert.deepEqual(logins, []);
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          url: preview.url,
          apiUrl: preview.apiUrl,
          accountRef: account.id,
          googleAccountRef: googleAccount.id,
          anthropicAccountRef: anthropic.id,
          loginCalls: logins.length,
        }),
      );
    } finally {
      await page.close();
    }
  },
);
