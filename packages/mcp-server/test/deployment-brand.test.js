import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const synthetic = {
  name: 'Fixture ASCII Product',
  displayName: 'Fixture Display Product',
  shortName: 'Fixture Short',
  hubName: 'Fixture Hub',
  tagline: 'Fixture Team',
};

function probe(brand) {
  const env = { ...process.env };
  delete env.TEST_DEPLOYMENT_BRAND;
  if (brand) env.TEST_DEPLOYMENT_BRAND = JSON.stringify(brand);
  const child = spawnSync(process.execPath, ['test/helpers/deployment-brand-probe.mjs'], {
    cwd: new URL('..', import.meta.url),
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim().split('\n').at(-1));
}

function withoutDescriptions(value) {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'description')
      .map(([key, child]) => [key, withoutDescriptions(child)]),
  );
}

const original = probe();
const configured = probe(synthetic);
assert.deepEqual(configured.brand, synthetic, 'the fixture reaches the actual selected profile');

function assertBrandProjection(before, after, label) {
  const old = JSON.stringify(before);
  const actual = JSON.stringify(after);
  const labels = [...new Set([original.brand.displayName, original.brand.name])];
  assert.ok(
    labels.some((name) => old.includes(name)),
    `${label}: baseline contains a product label`,
  );
  for (const name of labels) assert.ok(!actual.includes(name), `${label}: disconnected brand consumer: ${name}`);
  assert.ok(
    actual.includes(synthetic.name) || actual.includes(synthetic.displayName),
    `${label}: selected brand missing`,
  );
}

test('actual SDK tools/list projects every branded description and schema without changing validation', () => {
  assert.deepEqual(withoutDescriptions(configured.tools), withoutDescriptions(original.tools));
  let brandedTools = 0;
  for (let i = 0; i < original.tools.length; i += 1) {
    const before = original.tools[i];
    if ([original.brand.displayName, original.brand.name].some((label) => JSON.stringify(before).includes(label))) {
      assertBrandProjection(before, configured.tools[i], before.name);
      brandedTools += 1;
    }
  }
  assert.ok(brandedTools >= 10, 'exercise all existing branded tool families');
});

test('shared Dot contracts and system-command connector use the selected brand', () => {
  for (const key of ['dotTools', 'dotEvent', 'commandConnector'])
    assertBrandProjection(original[key], configured[key], key);
  assert.equal(configured.commandConnector.displayName, synthetic.displayName);
});

for (const key of ['callback', 'readMode', 'audio', 'companion', 'graph', 'recent']) {
  test(`actual ${key} execution output uses selected brand without a prior list requirement`, () => {
    assertBrandProjection(original.outputs[key], configured.outputs[key], key);
    assert.equal(configured.outputs[key].isError, original.outputs[key].isError);
  });
}
