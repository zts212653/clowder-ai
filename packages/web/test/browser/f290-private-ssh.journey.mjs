import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

// The operator supplies a running, isolated OpenSSH forward and the independent Service's own data directory.
// GitHub's external confirmation page is intercepted; no account is logged in or App actually registered.
test(
  'the packaged Client writes through real SSH and builds GitHub Manifest callbacks from the outside URL',
  { timeout: 60_000 },
  async (t) => {
    const serviceUrl = process.env.F290_SSH_SERVICE_URL;
    const dataDirectory = process.env.F290_SSH_DATA_DIR;
    const output = process.env.F290_SSH_EVIDENCE_DIR;
    assert.ok(
      serviceUrl && dataDirectory && output,
      'Explicit isolated SSH coordinates and evidence directory are required',
    );
    const bootstrapUrl = (await readFile(join(dataDirectory, 'owner-bootstrap.url'), 'utf8')).trim();
    assert.equal(new URL(bootstrapUrl).origin, new URL(serviceUrl).origin);
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('https://github.com/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<p>Isolated provider confirmation fixture. No GitHub App is registered.</p>',
      }),
    );
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(bootstrapUrl, { waitUntil: 'networkidle' });
    const begin = page.waitForResponse((response) => response.url().endsWith('/api/setup/github-app/begin'));
    await page.getByRole('button', { name: /在 GitHub 中创建|Create on GitHub/u }).click();
    const response = await begin;
    assert.equal(response.status(), 201);
    const result = await response.json();
    const manifest = result.manifest;
    assert.ok(manifest, 'The real Service must produce the registration manifest');
    assert.equal(manifest.url, new URL(serviceUrl).origin);
    assert.ok(manifest.redirect_url.startsWith(`${new URL(serviceUrl).origin}/api/setup/github-app/callback`));
    assert.deepEqual(manifest.callback_urls, [`${new URL(serviceUrl).origin}/api/auth/github/callback`]);
    assert.deepEqual(errors, []);
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: join(output, 'ssh-provider-setup.png'), fullPage: true });
    console.log(
      JSON.stringify({
        witness: 'actual-ssh-browser-post',
        browserOrigin: new URL(page.url()).origin,
        status: response.status(),
        provider: 'external-confirmation-fixture',
        callbacksUseOutsideOrigin: true,
      }),
    );
  },
);
