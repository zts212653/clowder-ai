import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { DSH_DESKTOP_RUNTIME } from '../dist/routes/dsh-desktop-runtime.js';
import { resolveDshDesktopLaunch } from '../dist/utils/dsh-desktop-launch.js';

// Exercise the shipped inspector; only its native module boundary is a fixture.
async function fixture(t, warnings = []) {
  const root = mkdtempSync(join(tmpdir(), 'desktop-patch-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nativeScope = join(root, 'modules');
  const nativeHome = join(root, 'native');
  const nativeCwd = join(nativeHome, 'profiles/desktop');
  mkdirSync(nativeCwd, { recursive: true });
  mkdirSync(nativeScope);
  writeFileSync(join(nativeCwd, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['fixture'] } } }));
  writeFileSync(join(nativeScope, 'package.json'), '{"type":"module","dsh":{"bundle":[]}}');
  writeFileSync(join(nativeHome, '.credentials.yaml'), 'FIXTURE_REF: fixture-value\n', { mode: 0o600 });
  const state = {
    warnings,
    rows: [
      { id: 'credentials', name: '@deepseek-ai/dsh-credentials-local', config: {} },
      {
        id: 'llm-deepseek',
        name: '@deepseek-ai/dsh-llm-deepseek-api-key',
        config: { models: [{ id: 'fixture-model' }] },
      },
    ],
  };
  const statePath = join(nativeScope, 'fixture.json');
  writeFileSync(statePath, JSON.stringify(state));
  const modules = {
    'dsh-app-boot': `
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
export const loadLayeredEnv = () => ({getFrom: () => undefined});
export const readProfileVersionExemptions = () => ({});
export const resolveBundleDir = () => fileURLToPath(new URL('../..', import.meta.url));
export const evaluatePluginCompatibility = () => undefined;
export const bundlePatchPaths = () => [];
export const loadOverlayPatches = () => [];
export const loadOptionalPatches = () => [];
export function composeEntries(_layers, warn) {
  const state = JSON.parse(readFileSync(new URL('../../fixture.json', import.meta.url), 'utf8'));
  state.warnings.forEach(warn);
  return state.rows;
}`,
    'dsh-credentials-local': `
import {join} from 'node:path';
export const resolveSpec = config => ({filename: join(config.dshHome, '.credentials.yaml')});
export const renderFlatLayoutMigration = () => null;
export const parseCredentialsDocument = () => ({refs: new Map([['FIXTURE_REF','fixture-value']]), records: new Map()});`,
    'dsh-credentials': 'export const credentialRef = value => value;',
    'dsh-llm-deepseek-api-key': `
export const inject = [];
export const resolveAdapterOptions = config => ({...config, apiKeyEnv: 'FIXTURE_REF'});`,
    'dsh-llm-deepseek': 'export const deepSeekConfigFields = {}, modelListingConfigFields = {};',
    'dsh-llm-pi-ai': 'export const inject = [];',
  };
  Object.entries(modules).forEach(([name, code]) => {
    const directory = join(nativeScope, name, 'lib');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'index.js'), code);
  });
  const bridge = join(root, 'bridge.mjs');
  writeFileSync(bridge, DSH_DESKTOP_RUNTIME);
  const { inspect } = await import(pathToFileURL(bridge).href);
  return { inspect: () => inspect({ nativeScope, nativeHome, nativeCwd }), state, statePath };
}

[
  'patch: entry "retired-plugin" not found',
  'patch: name mismatch for "ui-chat" (expected "@fixture/new", got "@fixture/old"), skipping',
].forEach((warning) => {
  test(`Desktop inspection tolerates an unrelated skipped override: ${warning}`, async (t) => {
    const { inspect, statePath } = await fixture(t, [warning]);
    const bytes = readFileSync(statePath, 'utf8');
    const result = await inspect();
    assert.equal(result.provider, 'deepseek-official');
    assert.equal(result.model, 'fixture-model');
    assert.equal(result.providers[0].credential, 'configured');
    assert.equal((await inspect()).revision, result.revision);
    assert.equal(readFileSync(statePath, 'utf8'), bytes);
  });
});

[
  ...['credentials', 'llm-deepseek', 'llm-pi-ai', 'agent-default-model'].flatMap((id) => [
    `patch: entry "${id}" not found`,
    `patch: name mismatch for "${id}" (expected "@fixture/new", got "@fixture/old"), skipping`,
  ]),
  'patch insert: entry "optional-group" not found',
  'patch insert: entry "optional-group" is not a group',
  'patch: id is required for non-insert patches',
  'patch: an unknown diagnostic containing PRIVATE_VALUE',
  ' patch: entry "retired-plugin" not found',
  'patch: entry "retired-plugin" not found trailing PRIVATE_VALUE',
].forEach((warning) => {
  test(`Desktop inspection still rejects an unsafe skipped patch: ${warning}`, async (t) => {
    const { inspect } = await fixture(t, [warning]);
    await assert.rejects(inspect, { message: 'dsh_config_complex_patch' });
  });
});

test('Desktop inspection keeps expression, ambiguity and provider identity checks', async (t) => {
  const { inspect, state, statePath } = await fixture(t);
  const original = structuredClone(state.rows);
  const credentials = original.find((row) => row.id === 'credentials');
  assert.ok(credentials);
  state.rows = original.map((row) =>
    row.id === 'credentials' ? { ...row, config: { __jsExpr: 'PRIVATE_VALUE' } } : row,
  );
  writeFileSync(statePath, JSON.stringify(state));
  await assert.rejects(inspect, { message: 'dsh_config_expression' });
  state.rows = [...original, credentials];
  writeFileSync(statePath, JSON.stringify(state));
  await assert.rejects(inspect, { message: 'dsh_config_ambiguous' });
  state.rows = original.map((row) =>
    row.id === 'credentials' ? { ...row, name: '@fixture/renamed-credentials' } : row,
  );
  writeFileSync(statePath, JSON.stringify(state));
  await assert.rejects(inspect, { message: 'dsh_config_manual' });
});

const desktopCommand = process.env.DSH_DESKTOP_TEST_COMMAND;
test(
  'native Desktop composes skipped optional overrides without changing its profile',
  {
    skip: !desktopCommand,
    timeout: 60_000,
  },
  async (t) => {
    assert.ok(desktopCommand);
    const plan = resolveDshDesktopLaunch(desktopCommand, []);
    assert.ok(plan);
    const entry = plan.args[1];
    assert.ok(entry);
    const root = mkdtempSync(join(tmpdir(), 'desktop-patch-native-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const nativeHome = join(root, 'native');
    const nativeCwd = join(nativeHome, 'profiles/desktop');
    mkdirSync(nativeCwd, { recursive: true });
    const bundle = join(nativeCwd, 'node_modules/@fixture/obsolete');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(
      join(bundle, 'package.json'),
      JSON.stringify({
        name: '@fixture/obsolete',
        version: '1.0.0',
        engines: { dsh: '0.0.0' },
      }),
    );
    writeFileSync(
      join(nativeCwd, 'package.json'),
      JSON.stringify({
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@fixture/obsolete'] } },
      }),
    );
    const credentials = join(nativeHome, '.credentials.yaml');
    writeFileSync(credentials, 'DEEPSEEK_API_KEY: fixture-key\n', { mode: 0o600 });
    const bridge = join(root, 'bridge.mjs');
    writeFileSync(bridge, DSH_DESKTOP_RUNTIME);
    const source = { nativeScope: dirname(dirname(dirname(entry))), nativeHome, nativeCwd };
    const patchPath = join(nativeCwd, 'cordis.patch.yml');
    const inspect = async () => {
      const { stdout } = await promisify(execFile)(
        plan.command,
        ['--expose-internals', bridge, 'inspect', JSON.stringify(source)],
        { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 20_000 },
      );
      return JSON.parse(stdout);
    };
    writeFileSync(patchPath, '- id: retired-plugin\n  config: { enabled: true }\n');
    const baseline = readFileSync(patchPath, 'utf8');
    const healthy = await inspect();
    assert.equal(healthy.provider, 'deepseek-official');
    assert.equal((await inspect()).revision, healthy.revision);
    assert.equal(readFileSync(patchPath, 'utf8'), baseline);
    assert.equal(readFileSync(credentials, 'utf8'), 'DEEPSEEK_API_KEY: fixture-key\n');
    writeFileSync(patchPath, '- id: ui-chat\n  name: "@fixture/retired-ui"\n');
    assert.equal((await inspect()).provider, 'deepseek-official');
    writeFileSync(patchPath, '- id: credentials\n  name: "@fixture/retired-credentials"\n');
    assert.deepEqual(await inspect(), { error: 'dsh_config_complex_patch' });
    writeFileSync(patchPath, '- id: optional-group\n  insert:\n    - id: llm-pi-ai\n');
    assert.deepEqual(await inspect(), { error: 'dsh_config_complex_patch' });
  },
);
