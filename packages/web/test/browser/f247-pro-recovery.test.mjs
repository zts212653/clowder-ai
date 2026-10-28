import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';
import { managerDot } from './f247-dot-entry.fixtures.mjs';

// Real recovery controller, chooser, Plugin Manager, confirmation and navigation.
// API wire states are controlled; actual archive/runner/preservation is tested separately.
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const origin = 'https://pro-recovery.test';
const pluginId = 'official.companion.personal-chrome';
const actionBase = `/api/plugins/${pluginId}/actions/`;
let browser, script, css;
const previousCwd = process.cwd();
before(async () => {
  process.chdir(webRoot);
  const result = await build({
    root: webRoot,
    configFile: false,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@': path.join(webRoot, 'src') } },
    define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin) },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: path.join(webRoot, 'test/browser/fixtures/f247-pro-recovery.tsx'),
        output: { format: 'es', inlineDynamicImports: true },
      },
    },
  });
  const outputs = Array.isArray(result) ? result.flatMap((value) => value.output) : result.output;
  script = outputs.find((value) => value.type === 'chunk' && value.isEntry).code;
  css = outputs
    .filter((value) => value.type === 'asset' && value.fileName.endsWith('.css'))
    .map((value) => value.source)
    .join('\n');
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  process.chdir(previousCwd);
});

function pro(installed, enabled, operationState) {
  return {
    ...managerDot(installed, enabled, true, true),
    pluginId,
    displayName: 'Personal Chrome Companion',
    source: {
      kind: 'catalog',
      catalogId: 'personal-chrome-companion',
      packageName: '@clowder-ai/personal-chrome-companion',
      trust: 'official',
    },
    description: '连接 Chrome 并授权指定 ChatGPT 会话。',
    availableVersion: '0.1.0-alpha.8',
    installedVersion: installed ? '0.1.0-alpha.8' : null,
    steps: [{ text: '安装并启用插件，再准备 Chrome 连接；安装不表示浏览器已连接。' }],
    configFields: installed
      ? [
          {
            key: 'personalChromeAuthorizations',
            kind: 'operation',
            label: 'ChatGPT conversation authorizations',
            currentValue: null,
            required: false,
            sensitive: false,
            operationState,
            actions: [{ id: 'list', label: 'Authorized conversations', render: 'status', resultRender: 'rows' }],
            rowActions: [
              { id: 'check-page', label: '检查会话页面' },
              { id: 'revoke', label: 'Revoke authorization', confirm: 'Revoke this authorization?' },
            ],
          },
          {
            key: 'hostChromeSetup',
            kind: 'operation',
            label: 'Chrome connection',
            currentValue: null,
            required: false,
            sensitive: false,
            actions: [
              { id: 'inspect', label: '检查 Chrome 连接安装', render: 'status', resultRender: 'rows' },
              {
                id: 'install',
                label: '安装或修复 Chrome 连接',
                render: 'button',
                next: 'inspect',
                confirm: '为当前安装准备本机连接？不会启动 Chrome 或授权任何对话。',
              },
            ],
          },
        ]
      : [],
    capabilities: [],
    contributions: [],
  };
}

for (const { presentation, width } of ['v1', 'v2'].flatMap((presentation) =>
  [1440, 390].map((width) => ({ presentation, width })),
))
  test(`Pro recovery installation, explicit enable, authorization and thread binding in ${presentation} at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.setDefaultTimeout(6000);
    let installed = false,
      enabled = false,
      authorized = false,
      bound = false,
      prepared = false,
      connected = false,
      pageReloadRequired = false;
    let authOperationState = { currentAction: 'list', updatedAt: 0 };
    const writes = [],
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((selected) => localStorage.setItem('cat-cafe:shell-presentation', selected), presentation);
    await page.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      assert.equal(url.origin, origin, 'the browser proof never accesses a live account or service');
      const answer = (body, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (url.pathname === '/proof.css') return route.fulfill({ contentType: 'text/css', body: css });
      if (!url.pathname.startsWith('/api/'))
        return route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>',
        });
      if (request.method() !== 'GET') writes.push(url.pathname);
      if (request.method() === 'POST' && url.pathname.startsWith(`${actionBase}personalChromeAuthorizations/`)) {
        authOperationState = {
          currentAction: url.pathname.split('/').at(-1),
          updatedAt: authOperationState.updatedAt + 1,
        };
      }
      if (url.pathname === '/api/session') return answer({ userId: 'isolated-owner', csrfToken: 'fixture-csrf' });
      if (url.pathname.endsWith('/cloud-bindings')) {
        if (request.method() === 'PATCH') {
          assert.deepEqual(request.postDataJSON(), {
            catId: 'gpt-pro',
            chatUrl: 'https://chatgpt.com/c/retained-pro',
          });
          bound = true;
        }
        return answer({
          bindings: bound ? { 'gpt-pro': 'https://chatgpt.com/c/retained-pro' } : {},
          cloudCat: { status: 'resolved', catId: 'gpt-pro' },
        });
      }
      if (url.pathname === '/api/plugin-manager/plugins/install') {
        installed = true;
        return answer({ pluginId });
      }
      if (url.pathname.endsWith('/set-enabled')) {
        assert.equal(request.postDataJSON().enabled, true);
        enabled = true;
        return answer({ pluginId });
      }
      const catalog = { status: 'fresh', refreshedAt: 1 };
      if (url.pathname === '/api/plugin-manager/plugins' || url.pathname === '/api/plugin-manager/plugins/_local')
        return answer({ plugins: [pro(installed, enabled, authOperationState)], catalog });
      if (url.pathname.endsWith('/documentation')) return answer({});
      if (url.pathname.endsWith('/contributions/tools')) return answer({ pluginId, tools: [] });
      if (
        url.pathname === `/api/plugin-manager/plugins/${pluginId}` ||
        url.pathname === `/api/plugin-manager/plugins/_local/${pluginId}`
      )
        return answer({ plugin: pro(installed, enabled, authOperationState), catalog });
      if (url.pathname === `${actionBase}personalChromeAuthorizations/list`)
        return installed
          ? answer({
              ok: true,
              render: 'rows',
              data: {
                rows: authorized
                  ? [
                      {
                        key: 'retained-pro',
                        label: '原来授权的会话',
                        actions: [
                          { action: 'revoke', input: { conversationId: 'retained-pro' } },
                          { action: 'check-page', input: { conversationId: 'retained-pro' } },
                        ],
                      },
                    ]
                  : [],
              },
            })
          : answer({ error: `Plugin '${pluginId}' is not installed` }, 404);
      if (url.pathname === `${actionBase}personalChromeAuthorizations/check-page`) {
        assert.deepEqual(request.postDataJSON(), { conversationId: 'retained-pro' });
        pageReloadRequired = false;
        return answer({
          ok: true,
          render: 'status',
          label: '原对话页面已就绪（未发送消息）',
          data: { health: { status: 'ready' } },
        });
      }
      if (url.pathname === `${actionBase}personalChromeAuthorizations/status`)
        return answer({
          ok: true,
          render: 'status',
          data: {
            helper: { state: connected ? 'connected' : prepared ? 'unreachable' : 'not_installed' },
            delivery: { reloadRequired: prepared && !connected, pageReloadRequired },
          },
        });
      if (url.pathname.startsWith(`${actionBase}hostChromeSetup/`)) {
        if (url.pathname.endsWith('/install')) {
          assert.equal(request.headers()['x-cat-cafe-owner-confirmed'], 'true');
          prepared = true;
        }
        return answer({
          ok: true,
          render: 'rows',
          data: {
            rows: [
              {
                key: 'installation',
                label: prepared ? '本机连接已安装' : '本机连接未安装',
                detail: prepared ? '在 Chrome 中加载扩展，再授权指定会话。安装不代表已连接。' : '请安装本机连接。',
              },
            ],
          },
        });
      }
      if (url.pathname === `${actionBase}personalChromeAuthorizations/refresh-titles`)
        return answer({ ok: true, render: 'status', data: {} });
      return answer({}, 404);
    });
    try {
      await page.goto(`${origin}/thread/thread-pro`);
      const recovery = page.getByTestId('cloud-binding-recovery-card');
      await recovery.getByRole('link', { name: '安装 Personal Chrome', exact: true }).click();
      await page.getByTestId('plugin-manager-detail').waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (process.env.F247_PRO_EVIDENCE_DIR && presentation === 'v1' && width === 390) {
        await mkdir(process.env.F247_PRO_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({
          path: path.join(process.env.F247_PRO_EVIDENCE_DIR, 'manager-v1-390.png'),
          fullPage: true,
        });
      }
      const install = page.getByTestId('plugin-manager-detail').getByRole('button', { name: '安装', exact: true });
      await install.click();
      const confirmation = page.getByRole('dialog');
      if (await confirmation.count()) await confirmation.getByRole('button', { name: '确认', exact: true }).click();
      const detail = page.getByTestId('plugin-manager-detail');
      await detail.getByRole('button', { name: /启用.*Personal Chrome/ }).click();
      await detail.getByRole('button', { name: /禁用.*Personal Chrome/ }).waitFor();
      await detail.getByRole('button', { name: '安装或修复 Chrome 连接', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
      await detail.getByText('本机连接已安装', { exact: true }).waitFor();
      assert.equal(installed && enabled, true);
      assert.equal(
        writes.some((value) => value.endsWith('/retry') || value.endsWith('/cloud-bindings')),
        false,
        'installation never sends or selects a conversation',
      );
      await page.goBack();
      await recovery.getByText(/Chrome 扩展需要重载/).waitFor();
      connected = true; // The owner loads/reloads the extension in their own Chrome.
      await recovery.getByRole('button', { name: '我已处理，重新检查', exact: true }).click();
      await recovery.getByRole('link', { name: '打开 ChatGPT 授权会话', exact: true }).waitFor();
      authorized = true; // The owner authorizes the exact conversation in Chrome, outside this UI proof.
      await recovery.getByRole('button', { name: '我已授权，重新检查', exact: true }).click();
      await recovery.getByText('原来授权的会话', { exact: true }).waitFor();
      assert.equal(bound, false, 'discovering an authorization never binds it automatically');
      pageReloadRequired = true; // A later exact probe observed an outdated conversation page.
      await page.reload();
      await recovery.getByText(/原对话页面仍在使用旧连接/).waitFor();
      assert.equal(await recovery.getByText(/Chrome 扩展需要重载/).count(), 0);
      assert.equal(await recovery.locator('[data-recovery-primary]').isDisabled(), true);
      assert.equal(bound, false);
      assert.equal(
        writes.some((value) => value.endsWith('/retry')),
        false,
      );
      if (process.env.F247_PRO_EVIDENCE_DIR) {
        await mkdir(process.env.F247_PRO_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({
          path: path.join(process.env.F247_PRO_EVIDENCE_DIR, `page-reload-${presentation}-${width}.png`),
          fullPage: true,
        });
      }
      // The owner has reloaded that original ChatGPT page; explicitly check its row in Settings.
      await recovery.getByRole('link', { name: '检查 Chrome 连接', exact: true }).click();
      const authRow = await page.getByTestId(`${pluginId}-row-retained-pro`).elementHandle();
      assert.ok(authRow);
      const listedBeforeCheck = writes.filter(
        (value) => value === `${actionBase}personalChromeAuthorizations/list`,
      ).length;
      const stateBeforeCheck = authOperationState.updatedAt;
      const detailRefresh = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === 'GET' &&
          [`/api/plugin-manager/plugins/${pluginId}`, `/api/plugin-manager/plugins/_local/${pluginId}`].includes(
            url.pathname,
          )
        );
      });
      await page.getByRole('button', { name: '检查会话页面', exact: true }).click();
      const refreshedDetail = await (await detailRefresh).json();
      assert.ok(
        refreshedDetail.plugin.configFields.find((field) => field.key === 'personalChromeAuthorizations').operationState
          .updatedAt > stateBeforeCheck,
        'the real detail callback must observe the advanced operation state',
      );
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const checkedRow = page.getByTestId(`${pluginId}-row-retained-pro`);
      await checkedRow.getByRole('status').filter({ hasText: '原对话页面已就绪（未发送消息）' }).waitFor();
      assert.equal(
        await checkedRow.getByRole('status').evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return rect.top < innerHeight && rect.bottom > 0;
        }),
        true,
        'row feedback stays beside the clicked conversation in the viewport',
      );
      if (width === 390) {
        const title = await checkedRow.locator('p').first().boundingBox();
        assert.ok(title.width > 120, 'mobile conversation titles retain readable width');
      }
      assert.equal(await authRow.evaluate((row) => row.isConnected), true, 'runtime-state refresh must retain the row');
      assert.equal(
        writes.filter((value) => value === `${actionBase}personalChromeAuthorizations/list`).length,
        listedBeforeCheck,
        'detail state refresh must not reset or re-list the operation',
      );
      if (process.env.F247_PRO_EVIDENCE_DIR) {
        await page.screenshot({
          path: path.join(process.env.F247_PRO_EVIDENCE_DIR, `page-check-${presentation}-${width}.png`),
          fullPage: true,
        });
      }
      await page.goBack();
      await recovery.getByText('原来授权的会话', { exact: true }).waitFor();
      // Bind through the thread chooser; sending a production message is outside this proof.
      const chooser = page.getByTestId('cloud-conversation-link');
      await chooser.getByRole('radio').waitFor();
      await chooser.getByRole('radio').check();
      await chooser.getByRole('button', { name: '连接这个会话', exact: true }).click();
      await chooser.locator('[data-route-status="connected"]').waitFor();
      await page.reload();
      await page.getByTestId('cloud-conversation-link').locator('[data-route-status="connected"]').waitFor();
      assert.equal(
        writes.some((value) => value.endsWith('/retry')),
        false,
      );
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      if (process.env.F247_PRO_EVIDENCE_DIR) {
        await mkdir(process.env.F247_PRO_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({
          path: path.join(process.env.F247_PRO_EVIDENCE_DIR, `recovery-${presentation}-${width}.png`),
          fullPage: true,
        });
      }
    } finally {
      await page.close();
    }
  });
