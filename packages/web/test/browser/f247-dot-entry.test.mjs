import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { managerDot, personalProState } from './f247-dot-entry.fixtures.mjs';
import { openProof } from './f247-dot-entry.harness.mjs';

for (const width of [1440, 390])
  test(`default avatar → plugin installation and retained dot setup at ${width}px`, async () => {
    let installed = false,
      paired = false,
      enabled = false,
      tested = false;
    const catalog = { status: 'fresh', refreshedAt: 1 };
    const status = () => ({
      installed,
      paired,
      subscription: paired ? 'active' : 'absent',
      endpointUrl: 'https://dot-fixture.test/mcp',
      replyAt: tested ? 100 : null,
      imageAt: null,
      revoked: false,
      ownerUserId: 'owner-1',
      allowedCatIds: [],
    });
    const proof = await openProof({
      viewport: { width, height: 1000 },
      api: ({ request, url }) => {
        const dot = managerDot(installed, enabled, tested, paired);
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
        if (url.pathname === '/api/plugin-manager/plugins/official.chatgpt-dot')
          return { body: { plugin: { ...dot, configFields: [], capabilities: [], contributions: [] }, catalog } };
        if (url.pathname.endsWith('/documentation')) return { body: {} };
        if (url.pathname.endsWith('/contributions/tools')) return { body: { pluginId: dot.pluginId, tools: [] } };
        if (url.pathname === '/api/plugins') return { body: { plugins: [] } };
        if (url.pathname === '/api/plugins/official') return { body: { plugins: [] } };
        if (url.pathname === '/api/plugins/personal-chrome') return { body: personalProState };
        if (url.pathname === '/api/plugins/chatgpt-dot/connection') return { body: status() };
        if (url.pathname === '/api/plugins/chatgpt-dot/prepare')
          return {
            body: {
              ...status(),
              endpointUrl: 'https://dot-fixture.test/mcp',
              instructions: '订阅猫咖召唤，配对码 fixture-only。',
            },
          };
        if (url.pathname === '/api/plugins/chatgpt-dot/test') {
          if (request.method() === 'POST') tested = true;
          return {
            body: {
              tests: tested
                ? ['A', 'B'].map((id) => ({
                    eventId: id,
                    threadId: `test-${id}`,
                    receivedAt: 1,
                    readAt: 2,
                    replyMessageId: `reply-${id}`,
                  }))
                : [],
            },
          };
        }
        return null;
      },
    });
    const { page } = proof;
    try {
      await page.getByTestId('settings-button').click();
      await page.getByTestId('settings-entry-connect').click();
      await page.getByTestId('settings-tab-plugins').click();
      assert.equal(new URL(page.url()).searchParams.has('pluginManagerLive'), false);
      const row = page.locator('[data-plugin-id="official.chatgpt-dot"]');
      await row.waitFor();
      assert.equal(await row.count(), 1);
      assert.equal(await page.locator('[data-plugin-id="personal-chrome-host"]').count(), 1);
      await row.getByRole('button', { name: '开启 dot 协作', exact: true }).click();
      await row.getByRole('button', { name: '启用dot协作', exact: true }).click();
      assert.equal(
        proof.requests.some((request) => request.endsWith('/set-enabled')),
        false,
        'blocked toggle opens setup without changing Host intent',
      );
      await page.getByRole('button', { name: '准备订阅说明', exact: true }).waitFor();
      await page.getByRole('button', { name: '准备订阅说明', exact: true }).click();
      await page.getByRole('button', { name: '复制订阅说明', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '复制插件地址', exact: true }).count(), 0);
      await page.getByText('沿用 ChatGPT 已连接的猫咖插件', { exact: false }).waitFor();
      if (process.env.F247_DOT_BROWSER_EVIDENCE_DIR) {
        await mkdir(process.env.F247_DOT_BROWSER_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({
          path: join(process.env.F247_DOT_BROWSER_EVIDENCE_DIR, `shared-setup-${width}.png`),
          fullPage: true,
        });
      }
      assert.equal(await page.getByText('收到过原图', { exact: true }).count(), 0);
      // Simulate the separately verified provider callback in the contract fixture.
      paired = true;
      await page.reload();
      if (width === 390)
        await page
          .locator('[data-plugin-id="official.chatgpt-dot"]')
          .getByRole('button')
          .filter({ hasText: 'ChatGPT 云端' })
          .click();
      else
        await page
          .locator('[data-plugin-id="official.chatgpt-dot"]')
          .getByRole('button')
          .filter({ hasText: 'ChatGPT 云端' })
          .click();
      await page.getByRole('button', { name: '测试两处往返', exact: true }).click();
      await page.getByRole('link', { name: '测试 A', exact: true }).waitFor();
      assert.equal(
        await page.getByRole('link', { name: '测试 B', exact: true }).getAttribute('href'),
        '/thread/test-B',
      );
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (process.env.F247_DOT_BROWSER_EVIDENCE_DIR) {
        await mkdir(process.env.F247_DOT_BROWSER_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({
          path: join(process.env.F247_DOT_BROWSER_EVIDENCE_DIR, `contract-setup-${width}.png`),
          fullPage: true,
        });
      }
      if (width === 390) {
        await page.getByRole('button', { name: '返回插件列表', exact: true }).click();
        await row.waitFor();
      }
      await row.getByRole('button', { name: '启用dot协作', exact: true }).click();
      await row.getByRole('button', { name: '禁用dot协作', exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('from'), 'thread-return');
      // The original receipt's recovery entry must select dot even after a cold
      // catalog load, and must open its detail on mobile without another tap.
      await page.goto(new URL('/settings?s=plugins&from=thread-return#chatgpt-dot', page.url()).href);
      await page.getByText('ChatGPT 云端 · dot 会话', { exact: true }).waitFor();
      assert.equal(await page.locator('[data-mobile-panel="detail"]').isVisible(), true);
      await page.reload();
      await page.getByText('ChatGPT 云端 · dot 会话', { exact: true }).waitFor();
      assert.equal(await page.locator('[data-mobile-panel="detail"]').isVisible(), true);
      if (width === 390) {
        await page.getByRole('button', { name: '返回插件列表', exact: true }).click();
        assert.equal(await page.locator('[data-mobile-panel="list"]').isVisible(), true);
      }
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
