import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { remoteModuleHost } from './f290-remote-module.fixture.mjs';

test(
  'two connector-only plugin instances pair through the real Host frame and SSH, then recover the original endpoints',
  { timeout: 120_000 },
  async (t) => {
    const directory = process.env.F290_SSH_DATA_DIR,
      output = process.env.F290_SSH_EVIDENCE_DIR;
    assert.ok(directory && output && process.env.F290_PLUGIN_PACKAGE_ROOT);
    const f = JSON.parse(await readFile(join(directory, 'isolated-browser-sessions.json'), 'utf8'));
    const hosts = [];
    let browser;
    t.after(async () => {
      await browser?.close();
      for (const host of hosts) await host.close();
    });
    hosts.push(await remoteModuleHost({ directory, serviceUrl: f.origin, port: 19411, label: 'A' }));
    hosts.push(await remoteModuleHost({ directory, serviceUrl: f.origin, port: 19412, label: 'B' }));
    browser = await chromium.launch({ headless: true });
    const receipts = [];
    for (const [index, human] of [f.owner, f.member].entries()) {
      const host = hosts[index];
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.addInitScript(
        ({ origin, token }) => {
          if (location.origin === origin) sessionStorage.setItem(`collective-session:${origin}`, token);
        },
        { origin: f.origin, token: human.sessionToken },
      );
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(host.url + '/collective', { waitUntil: 'networkidle' });
      const frame = page.frameLocator('iframe[title="Collective"]');
      assert.equal(new URL(await page.locator('iframe').getAttribute('src'), host.url).origin, f.origin);
      assert.equal(await page.getByText('新建共同体', { exact: true }).count(), 0);
      await frame.getByRole('button', { name: '带猫进来', exact: true }).click();
      await page.getByRole('heading', { name: '先看清要带来的伙伴', exact: true }).waitFor();
      await page.screenshot({ path: join(output, `ssh-cafe-${index}-pairing.png`), fullPage: true });
      const paired = page.waitForResponse((response) => response.url().endsWith('/official.collective-connector/pair'));
      await page.getByRole('button', { name: '确认带入 1 位伙伴', exact: true }).click();
      const response = await paired;
      assert.equal(response.status(), 200);
      const connection = await response.json();
      assert.equal(connection.serviceUrl, f.origin);
      assert.equal(connection.serviceInstanceId, f.serviceInstanceId);
      assert.equal(connection.authorizedHumanId, human.human.humanId);
      await page.getByRole('heading', { name: '先看清要带来的伙伴', exact: true }).waitFor({ state: 'hidden' });
      await host.restart();
      const restored = await host.status();
      assert.equal(restored.localService, undefined);
      assert.equal(restored.remoteService.state, 'ready');
      assert.equal(restored.connections.length, 1);
      assert.equal(restored.connections[0].connectionId, connection.connectionId);
      assert.equal(restored.connections[0].endpointId, connection.endpointId);
      await assert.rejects(readFile(join(host.dataPath, 'service/collective-service.json')), { code: 'ENOENT' });
      await page.reload({ waitUntil: 'networkidle' });
      assert.equal(new URL(await page.locator('iframe').getAttribute('src'), host.url).origin, f.origin);
      assert.deepEqual(errors, []);
      receipts.push({
        humanId: human.human.humanId,
        connectionId: connection.connectionId,
        endpointId: connection.endpointId,
        serviceInstanceId: connection.serviceInstanceId,
        serviceUrl: connection.serviceUrl,
        localServiceCreated: false,
        restored: true,
      });
      await page.screenshot({ path: join(output, `ssh-cafe-${index}-restored.png`), fullPage: true });
    }
    assert.notEqual(receipts[0].endpointId, receipts[1].endpointId);
    assert.notEqual(receipts[0].humanId, receipts[1].humanId);
    await writeFile(
      join(output, 'ssh-cafe-pairing.json'),
      JSON.stringify(
        {
          transport: 'actual OpenSSH',
          provider: 'fixture',
          hostBoundary: 'production Core surface and plugin module; owner authentication/roster fixture',
          receipts,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'Both real plugin modules paired through their actual Core iframe and SSH; restart kept both distinct original endpoints.',
    );
  },
);
