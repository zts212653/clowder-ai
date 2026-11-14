import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  configFields,
  managerDot,
  personalProState,
  projectDotJourney,
  setupSteps,
} from './f247-dot-entry.fixtures.mjs';
import { openProof } from './f247-dot-entry.harness.mjs';
import { disabledWatcherRead } from './fixtures/f322-watcher-read.mjs';

for (const width of [1440, 390])
  test(`default settings installs Dot and retains package setup at ${width}px`, async () => {
    let installed = false,
      enabled = false,
      subscribed = false,
      connection = null;
    const catalog = { status: 'fresh', refreshedAt: 1 };
    const status = () =>
      projectDotJourney({
        runtimeRunning: enabled,
        now: Date.now(),
        connection: connection && {
          ...connection,
          ...(subscribed ? { pairedAt: Date.now(), subscription: { expiresAt: null } } : {}),
        },
        dispatches: subscribed
          ? [
              {
                eventId: 'verified',
                attemptId: 'fixture',
                occurredAt: Date.now(),
                sourceReadAt: Date.now(),
                replyMessageId: 'reply',
                threadId: 'test-source',
              },
            ]
          : [],
        external: {
          v: 1,
          revision: 1,
          pending: null,
          current: { kind: 'legacy', recordRef: 'host.external' },
          endpoint: { mode: 'long-lived', serverUrl: 'https://dot-fixture.test/mcp', reachableAt: Date.now() },
        },
      });
    const instructions = '请在 Work 对话订阅 dot.summoned，pairing_code=fixture-only';
    const proof = await openProof({
      viewport: { width, height: 1000 },
      api: ({ request, url }) => {
        const watcher = disabledWatcherRead(request, url, ['thread-return']);
        if (watcher) return { raw: watcher.body };
        if (url.pathname === '/api/agent-providers' && request.method() === 'GET') return { body: { libraries: [] } };
        const dot = managerDot(installed, enabled);
        if (url.pathname === '/api/plugin-manager/plugins/_local')
          return { body: { plugins: installed ? [dot] : [], catalog } };
        if (url.pathname === '/api/plugin-manager/marketplaces/refresh')
          return { body: { sources: [{ status: 'ready' }] } };
        if (url.pathname === '/api/plugin-manager/plugins/install') {
          installed = true;
          return { body: { pluginId: dot.pluginId } };
        }
        if (url.pathname.endsWith('/set-enabled')) {
          enabled = request.postDataJSON().enabled;
          return { body: {} };
        }
        if (url.pathname === '/api/plugin-manager/plugins' || url.pathname.endsWith('/plugins/search'))
          return { body: { plugins: [dot], catalog } };
        if (
          url.pathname === '/api/plugin-manager/plugins/official.chatgpt-dot' ||
          url.pathname === '/api/plugin-manager/plugins/_local/official.chatgpt-dot'
        )
          return {
            body: { plugin: { ...dot, configFields, steps: setupSteps, capabilities: [], contributions: [] }, catalog },
          };
        if (url.pathname.endsWith('/documentation')) return { body: {} };
        if (url.pathname.endsWith('/contributions/tools')) return { body: { pluginId: dot.pluginId, tools: [] } };
        if (url.pathname === '/api/plugins' || url.pathname === '/api/plugins/official')
          return { body: { plugins: [] } };
        if (url.pathname === '/api/plugins/personal-chrome') return { body: personalProState };
        if (url.pathname === '/api/plugins/official.chatgpt-dot/actions/connection/status')
          return { body: { ok: true, render: 'rows', data: status() } };
        if (url.pathname === '/api/plugins/official.chatgpt-dot/actions/subscription/show-instructions') {
          connection = {
            attemptId: 'fixture',
            pairingExpiresAt: Date.now() + 30 * 60_000,
            pairedAt: null,
            revokedAt: null,
            subscription: null,
            testEventIds: ['verified'],
          };
          return { body: { ok: true, render: 'text', data: instructions } };
        }
        return null;
      },
    });
    const { page } = proof;
    try {
      await page.getByTestId('settings-button').click();
      if (width === 390) await page.locator('button[aria-controls="settings-mobile-navigation"]').click();
      await page.getByTestId('settings-entry-connect').click();
      await page.getByTestId('settings-tab-plugins').click();
      const row = page.locator('[data-plugin-id="official.chatgpt-dot"]');
      await row.waitFor();
      assert.equal(await row.count(), 1);
      assert.equal(await page.locator('[data-plugin-id="personal-chrome-host"]').count(), 0);
      await row.getByRole('button', { name: '安装', exact: true }).click();
      assert.equal(installed, true);
      await row.getByRole('button', { name: /^启用/ }).click();
      assert.equal(enabled, true, 'Host enables the configured package before its own pairing workflow');
      await row.getByRole('button').filter({ hasText: 'ChatGPT Dot' }).click();
      await page.getByRole('button', { name: '生成订阅消息', exact: true }).click();
      await page.getByText(instructions, { exact: true }).waitFor();
      await page.getByText('等待订阅', { exact: true }).waitFor();
      assert.equal(
        proof.requests.some((request) => request.includes('/api/plugins/chatgpt-dot/')),
        false,
        'setup uses generic package actions',
      );
      // A separately tested provider callback changes the UI fixture; this is not live OAuth/dogfood.
      subscribed = true;
      await page.getByText('Dot 已可用', { exact: true }).waitFor();
      assert.equal(
        await page.getByText(instructions, { exact: true }).count(),
        1,
        'subscription instructions stay copyable after automatic verification',
      );
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (process.env.F247_DOT_BROWSER_EVIDENCE_DIR) {
        await mkdir(process.env.F247_DOT_BROWSER_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({
          path: join(process.env.F247_DOT_BROWSER_EVIDENCE_DIR, `contract-setup-${width}.png`),
          fullPage: true,
        });
      }
      await page.goto(new URL('/settings?s=plugins&from=thread-return#chatgpt-dot', page.url()).href);
      await page.getByRole('button', { name: '生成订阅消息', exact: true }).waitFor();
      assert.equal(await page.locator('[data-mobile-panel="detail"]').isVisible(), true);
      await page.reload();
      await page.getByText('Dot 已可用', { exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('from'), 'thread-return');
      if (width === 390) await page.getByRole('button', { name: '返回插件列表', exact: true }).click();
      await row.getByRole('button', { name: /^禁用/ }).click();
      assert.equal(enabled, false);
      assert.deepEqual(proof.errors, []);
      assert.deepEqual(proof.unexpected, []);
    } catch (error) {
      console.error(
        JSON.stringify({
          width,
          requests: proof.requests,
          errors: proof.errors,
          body: (await page.locator('body').innerText()).slice(0, 2500),
        }),
      );
      throw error;
    } finally {
      await page.close();
    }
  });
