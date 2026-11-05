import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('actual API display consumers use the selected synthetic deployment brand', () => {
  const brand = {
    name: 'Runtime ASCII',
    displayName: 'Runtime <Display>&: Label',
    shortName: 'Runtime',
    hubName: 'Runtime Hub',
    tagline: 'Runtime team',
  };
  const result = spawnSync(
    process.execPath,
    [
      '--no-warnings',
      '--experimental-loader',
      fileURLToPath(new URL('../../mcp-server/test/helpers/deployment-brand-loader.mjs', import.meta.url)),
      fileURLToPath(new URL('./helpers/deployment-display-probe.mjs', import.meta.url)),
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        TEST_DEPLOYMENT_BRAND: JSON.stringify(brand),
        TEST_DEPLOYMENT_REPOSITORY: 'synthetic-owner/runtime-repo',
      },
      timeout: 15000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.repository, 'synthetic-owner/runtime-repo');
  assert.equal(output.dotServerInfo.name, `${brand.displayName} dot`);
  assert.equal(output.dotServerInfo.version, '0.1.0');
  if (process.platform !== 'win32') assert.equal(output.guardRepository, 'synthetic-owner/runtime-repo');
  for (const value of [
    output.summary,
    output.routing,
    output.manifest,
    output.email.subject,
    output.email.text,
    output.inApp,
  ]) {
    assert.ok(value.includes(brand.displayName), value);
  }
  assert.ok(output.quest.includes(`Hello ${brand.name}`));
  assert.ok(output.from.startsWith(`${brand.name} Signals `));
  assert.ok(output.marketplace[0].includes(brand.name));
  assert.ok(output.marketplace[2].includes(brand.name));
  assert.match(output.email.html, /Runtime &lt;Display&gt;&amp;/);
  assert.doesNotMatch(output.email.html, /Runtime <Display>/);
  for (const description of output.nativeDescriptions) assert.ok(description.startsWith(brand.displayName));
});
