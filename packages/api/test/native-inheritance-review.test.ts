import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareDshNativeConfiguration, readDshNativeConfiguration } from '../src/config/dsh-native-configuration.js';
import { nativeRuntimeReadiness } from '../src/routes/native-runtime-readiness.js';
import { discoverNativeRuntimes } from '../src/routes/native-runtimes.js';
import { nativeConfigurationRevision } from '../src/routes/native-tool-defaults.js';

test('bundle-only defaults use the installed declaration and profile/home overlays without a model constant', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bundle-default-'));
  const profile = join(home, 'profiles/desktop');
  const bundle = join(profile, 'node_modules/@fixture/base');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@fixture/base'] } } }));
  writeFileSync(
    join(bundle, 'package.json'),
    JSON.stringify({ name: '@fixture/base', dsh: { bundle: { patch: 'defaults.yml' } } }),
  );
  writeFileSync(
    join(bundle, 'defaults.yml'),
    '- insert:\n  - id: llm-pi-ai\n    config:\n      providers:\n        bundle-provider:\n          models: [{ id: bundle-model }]\n  - id: agent-default-model\n    config: { provider: bundle-provider, model: bundle-model }\n',
  );
  writeFileSync(join(profile, 'cordis.patch.yml'), '- id: ui-chat\n  config: { transcriptView: standard }\n');
  assert.equal(readDshNativeConfiguration(home)?.model, '["bundle-provider","bundle-model"]');
  writeFileSync(
    join(home, 'cordis.patch.yml'),
    '- id: agent-default-model\n  config: { provider: bundle-provider, model: changed-by-home }\n',
  );
  assert.equal(readDshNativeConfiguration(home)?.model, '["bundle-provider","changed-by-home"]');
});

test('bundle metadata need not be exported and a stale plugin name cannot override the actual default', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-sealed-bundle-'));
  const profile = join(home, 'profiles/desktop');
  const bundle = join(profile, 'node_modules/@fixture/sealed');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(profile, 'package.json'), '{"dsh":{"profile":{"bundles":["@fixture/sealed"]}}}');
  writeFileSync(
    join(bundle, 'package.json'),
    JSON.stringify({ exports: { '.': './index.js' }, dsh: { bundle: { patch: 'defaults.yml' } } }),
  );
  writeFileSync(join(bundle, 'index.js'), 'throw Error("never import bundle code")');
  writeFileSync(
    join(bundle, 'defaults.yml'),
    '- insert:\n  - id: agent-default-model\n    name: current-default\n    config: { provider: deepseek-official, model: declared-model }\n',
  );
  assert.equal(readDshNativeConfiguration(home)?.model, '["deepseek-official","declared-model"]');
  writeFileSync(
    join(profile, 'cordis.patch.yml'),
    '- id: agent-default-model\n  name: retired-default\n  config: { provider: deepseek-official, model: stale-model }\n',
  );
  assert.equal(readDshNativeConfiguration(home)?.model, '["deepseek-official","declared-model"]');
});

test('DSH credential readiness uses the same cached or explicit CLI installation as discovery', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-readiness-launch-'));
  const home = join(root, 'home');
  const profile = join(home, 'profiles/desktop');
  const installation = join(root, 'installation');
  const bundle = join(installation, 'node_modules/@fixture/base');
  mkdirSync(profile, { recursive: true });
  mkdirSync(join(installation, 'lib'), { recursive: true });
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(profile, 'package.json'), '{"dsh":{"profile":{"bundles":["@fixture/base"]}}}');
  writeFileSync(join(installation, 'package.json'), '{"name":"@deepseek-ai/dsh"}');
  writeFileSync(join(installation, 'lib/bin.js'), '// metadata only');
  writeFileSync(join(bundle, 'package.json'), '{"dsh":{"bundle":{"patch":"defaults.yml"}}}');
  writeFileSync(
    join(bundle, 'defaults.yml'),
    '- insert:\n  - id: llm-pi-ai\n    config: { providers: { fixture: { apiKeyEnv: FIXTURE_CACHED_DSH_MISSING_KEY, models: [{ id: actual-model }] } } }\n  - id: agent-default-model\n    config: { provider: fixture, model: actual-model }\n',
  );
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  });
  const runtime = {
    id: 'dsh',
    installed: true,
    command: process.execPath,
    acp: { command: process.execPath, startupArgs: [join(installation, 'lib/bin.js'), '--profile', 'acp'] },
  };
  assert.equal((await nativeRuntimeReadiness(runtime, root)).status, 'configuration_required');
});

test('an unrelated Node package never receives DSH configuration', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'not-dsh-'));
  const entry = join(root, 'other/lib/bin.js');
  mkdirSync(join(root, 'other/lib'), { recursive: true });
  writeFileSync(join(root, 'other/package.json'), '{"name":"@fixture/other-client"}');
  writeFileSync(entry, '// not DSH');
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  });
  assert.equal(prepareDshNativeConfiguration(process.execPath, [entry, '--profile', 'acp'], root), undefined);
});

test('a native profile whose default cannot be read never silently falls back to stale ACP', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-unreported-default-'));
  const profile = join(home, 'profiles/desktop');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), '{"dsh":{"profile":{"bundles":["@fixture/missing"]}}}');
  assert.throws(() => readDshNativeConfiguration(home), /dsh_default_unreported/);
});

test('invalid Codex and DSH layouts do not remove unrelated native clients or their catalog', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'native-invalid-layout-'));
  const previous = new Map(['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'DSH_HOME'].map((key) => [key, process.env[key]]));
  t.after(() =>
    previous.forEach((value, key) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }),
  );
  ['codex', 'claude', 'dsh'].forEach((dir) => mkdirSync(join(root, dir)));
  process.env.CODEX_HOME = join(root, 'codex');
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
  process.env.DSH_HOME = join(root, 'dsh');
  writeFileSync(join(root, 'codex/config.toml'), 'model = ???');
  writeFileSync(join(root, 'claude/settings.json'), '{"model":"working-model"}');
  writeFileSync(join(root, 'dsh/profiles'), 'not a directory');
  const found = discoverNativeRuntimes(root, () => null);
  assert.equal(found.runtimes.find((runtime) => runtime.id === 'claude')?.configuredModel, 'working-model');
  assert.doesNotThrow(() => nativeConfigurationRevision(root));
});
