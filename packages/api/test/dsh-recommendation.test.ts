import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse, stringify } from 'yaml';
import { inspectDshRecommendation } from '../src/routes/dsh-recommendation.js';
import { buildDshPatch, inspectDshConfig } from '../src/routes/dsh-setup-config.js';
import { assertDefaultDshCredentialStore } from '../src/routes/dsh-setup-credential-store.js';
import { resolveDshSetupLaunch } from '../src/routes/dsh-setup-launch.js';
import { inspectDshRouteReadiness } from '../src/routes/dsh-setup-readiness.js';
import { prepareDshSetup, readDshSetup } from '../src/routes/dsh-setup-service.js';

test('official native DeepSeek provider needs its actual credential and retains the declared ACP model', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-official-recommendation-'));
  const source = stringify([
    { id: 'llm-pi-ai' },
    { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key' },
    { id: 'acp', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
  ]);
  assert.deepEqual(inspectDshConfig(source).providers, [
    { id: 'deepseek-official', models: [{ id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' }] },
  ]);
  assert.equal(inspectDshRouteReadiness(source, home, home, {}).providers[0]?.credentialStatus, 'missing');
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: isolated-fixture-only\n');
  assert.equal(inspectDshRouteReadiness(source, home, home, {}).providers[0]?.credentialStatus, 'configured');
  const patch = parse(buildDshPatch(source, source, 'deepseek-official', 'deepseek-v4-flash'));
  assert.ok(!JSON.stringify(patch).includes('isolated-fixture-only'));
  assert.equal(patch.find((row: { id: string }) => row.id === 'acp').config.provider, 'deepseek-official');
});

test('a saved pi-ai catalog route retains its model even when no explicit catalog override was stored', () => {
  const source = stringify([
    { id: 'llm-pi-ai', config: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } } },
    { id: 'agent-default-model', config: { provider: 'openai', model: 'saved-model' } },
  ]);
  assert.deepEqual(inspectDshConfig(source).providers, [
    { id: 'openai', models: [{ id: 'saved-model', label: 'saved-model' }] },
  ]);
});

test('readiness uses the actual credential precedence and rejects invalid selected key bytes', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-key-precedence-'));
  const source = stringify([
    { id: 'llm-pi-ai', config: { providers: { company: { apiKeyEnv: 'COMPANY_KEY', models: [{ id: 'chosen' }] } } } },
  ]);
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  COMPANY_KEY: valid-stored-fixture\n', {
    mode: 0o600,
  });
  assert.equal(
    inspectDshRouteReadiness(source, home, home, { COMPANY_KEY: '   ' }).providers[0]?.credentialStatus,
    'missing',
  );
  assert.equal(
    inspectDshRouteReadiness(source, home, home, { COMPANY_KEY: '\u4e2d\u6587' }).providers[0]?.credentialStatus,
    'missing',
  );
  assert.equal(
    inspectDshRouteReadiness(source, home, home, { COMPANY_KEY: '' }).providers[0]?.credentialStatus,
    'configured',
  );
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  COMPANY_KEY: ""\n', { mode: 0o600 });
  assert.throws(
    () => inspectDshRouteReadiness(source, home, home, { COMPANY_KEY: 'valid-env-fixture' }),
    /credential_unavailable/,
  );
});

test('an explicit invalid credential reference never falls back to ambient official authentication', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-invalid-ref-'));
  const source = stringify([
    { id: 'llm-deepseek', config: { apiKeyEnv: '' } },
    { id: 'acp', config: { provider: 'deepseek-official', model: 'chosen' } },
  ]);
  assert.throws(
    () => inspectDshRouteReadiness(source, home, home, { DEEPSEEK_API_KEY: 'valid-env-fixture' }),
    /config_invalid/,
  );
});

test('invalid unrelated credential records prevent recommendation before the native service can boot', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-invalid-record-'));
  const source = stringify([
    { id: 'llm-pi-ai', config: { providers: { company: { apiKeyEnv: 'COMPANY_KEY', models: [{ id: 'chosen' }] } } } },
  ]);
  for (const records of [
    7,
    { 'llm-pi-ai/other': 7 },
    { 'llm-pi-ai/other': { kind: 'unexpected' } },
    { 'llm-pi-ai/other': { kind: 'api-key', key: '' } },
  ]) {
    writeFileSync(
      join(home, '.credentials.yaml'),
      stringify({ version: 1, refs: { COMPANY_KEY: 'valid-fixture' }, records }),
      { mode: 0o600 },
    );
    assert.throws(() => inspectDshRouteReadiness(source, home, home, {}), /credential_unavailable/);
  }
  writeFileSync(
    join(home, '.credentials.yaml'),
    stringify({
      version: 1,
      refs: { COMPANY_KEY: 'valid-fixture' },
      records: { 'llm-pi-ai/other': { kind: 'grant', payload: { nested: ['opaque', null, 1] } } },
    }),
    { mode: 0o600 },
  );
  assert.equal(inspectDshRouteReadiness(source, home, home, {}).providers[0]?.credentialStatus, 'configured');
});

test('pre-release flat credential files are reusable only within the native migration recognizer', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-flat-credential-'));
  const source = stringify([
    { id: 'llm-pi-ai', config: { providers: { company: { apiKeyEnv: 'COMPANY_KEY', models: [{ id: 'chosen' }] } } } },
  ]);
  for (const directive of ['---', '...', '%YAML 1.2\n---']) {
    writeFileSync(join(home, '.credentials.yaml'), `${directive}\nCOMPANY_KEY: valid-fixture\n`, { mode: 0o600 });
    assert.throws(() => inspectDshRouteReadiness(source, home, home, {}), /credential_unavailable/);
  }
  writeFileSync(join(home, '.credentials.yaml'), 'COMPANY_KEY: valid-fixture\n', { mode: 0o600 });
  assert.equal(inspectDshRouteReadiness(source, home, home, {}).providers[0]?.credentialStatus, 'configured');
});

test('automatic readiness never reads the default key when the native resolver uses another store or is disabled', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-credential-source-'));
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  COMPANY_KEY: valid-default-fixture\n', {
    mode: 0o600,
  });
  const models = {
    id: 'llm-pi-ai',
    config: { providers: { company: { apiKeyEnv: 'COMPANY_KEY', models: [{ id: 'chosen' }] } } },
  };
  const resolver = { id: 'credentials', name: '@deepseek-ai/dsh-credentials-local' };
  for (const rows of [
    [{ ...resolver, config: { path: join(home, 'another-store.yaml') } }],
    [{ ...resolver, config: { dshHome: join(home, 'another-home') } }],
    [{ ...resolver, disabled: true }],
    [{ ...resolver, name: '@private/other-credentials' }],
    [resolver, { ...resolver, id: 'another-credentials' }],
  ])
    assert.throws(() => inspectDshRouteReadiness(stringify([models, ...rows]), home, home, {}), /custom_startup/);
  const explicitDefaults = {
    ...resolver,
    config: { path: join(home, 'unused', '..', '.credentials.yaml'), dshHome: home },
  };
  assert.equal(
    inspectDshRouteReadiness(stringify([models, explicitDefaults]), home, home, {}).providers[0]?.credentialStatus,
    'configured',
  );
  if (process.platform === 'win32')
    assert.equal(
      inspectDshRouteReadiness(
        stringify([models, { ...resolver, config: { path: join(home, '.credentials.yaml').toUpperCase() } }]),
        home,
        home,
        {},
      ).providers[0]?.credentialStatus,
      'configured',
    );
});

test('native path stays literal, dshHome alone expands tilde, and extra unknown credential services stay manual', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-credential-path-'));
  const home = join(homedir(), '.dsh');
  const resolver = { id: 'credentials', name: '@deepseek-ai/dsh-credentials-local' };
  assert.throws(
    () =>
      assertDefaultDshCredentialStore(
        stringify([{ ...resolver, config: { path: '~/.dsh/.credentials.yaml' } }]),
        home,
        root,
      ),
    /custom_startup/,
  );
  assert.doesNotThrow(() =>
    assertDefaultDshCredentialStore(stringify([{ ...resolver, config: { dshHome: '~/.dsh' } }]), home, root, true),
  );
  assert.throws(
    () =>
      assertDefaultDshCredentialStore(
        stringify([resolver, { id: 'other', name: '@private/credentials-service' }]),
        home,
        root,
        true,
      ),
    /custom_startup/,
  );
});

test('automatic local resolver admission accepts only its supported literal configuration', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-resolver-schema-'));
  const resolver = { id: 'credentials', name: '@deepseek-ai/dsh-credentials-local' };
  for (const config of [
    { watch: 7 },
    { debounceMs: -1 },
    { debounceMs: Number.POSITIVE_INFINITY },
    { unexpected: true },
  ]) {
    assert.throws(
      () => assertDefaultDshCredentialStore(stringify([{ ...resolver, config }]), home, home, true),
      /custom_startup/,
    );
  }
  assert.throws(
    () =>
      assertDefaultDshCredentialStore(
        '- id: credentials\n  name: !!js "@deepseek-ai/dsh-credentials-local"\n',
        home,
        home,
        true,
      ),
    /custom_startup/,
  );
  assert.doesNotThrow(() =>
    assertDefaultDshCredentialStore(
      stringify([{ ...resolver, config: { watch: false, debounceMs: 0 } }]),
      home,
      home,
      true,
    ),
  );
});

test('an empty project dotenv masks HOME, while empty inherited environment permits a valid saved key', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-dotenv-precedence-'));
  const cwd = join(home, 'bootstrap');
  mkdirSync(cwd);
  const source = stringify([
    { id: 'llm-pi-ai', config: { providers: { company: { apiKeyEnv: 'COMPANY_KEY', models: [{ id: 'chosen' }] } } } },
  ]);
  writeFileSync(join(home, '.env'), 'COMPANY_KEY=valid-home-fixture\n');
  writeFileSync(join(cwd, '.env'), 'COMPANY_KEY=\n');
  assert.equal(inspectDshRouteReadiness(source, home, cwd, {}).providers[0]?.credentialStatus, 'missing');
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  COMPANY_KEY: valid-saved-fixture\n', {
    mode: 0o600,
  });
  assert.equal(
    inspectDshRouteReadiness(source, home, cwd, { COMPANY_KEY: '' }).providers[0]?.credentialStatus,
    'configured',
  );
  if (process.platform === 'win32')
    assert.equal(
      inspectDshRouteReadiness(source, home, cwd, { company_key: 'valid-env-fixture' }).providers[0]?.credentialStatus,
      'configured',
    );
});

test('recommendation reuses a credentialed Desktop route and its saved selection without editing native files', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-recommendation-'));
  const home = join(root, 'native-home'),
    host = join(root, 'host'),
    pkg = join(root, 'dsh');
  mkdirSync(host);
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  const before = { DSH_HOME: process.env.DSH_HOME, CAT_CAFE_CONFIG_ROOT: process.env.CAT_CAFE_CONFIG_ROOT };
  process.env.DSH_HOME = home;
  process.env.CAT_CAFE_CONFIG_ROOT = host;
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const active = stringify([
    { id: 'credentials', name: '@deepseek-ai/dsh-credentials-local' },
    { id: 'llm-pi-ai', config: { providers: { 'deepseek-official': { models: [{ id: 'official' }] } } } },
    { id: 'acp', config: { provider: 'deepseek-official', model: 'official' } },
  ]);
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }));
  const entry = join(pkg, 'lib/bin.js');
  writeFileSync(
    entry,
    `const fs=require('node:fs'); const i=process.argv.lastIndexOf('--patch'); process.stdout.write(i<0?${JSON.stringify(active)}:fs.readFileSync(process.argv[i+1], 'utf8'));`,
  );
  const desktop = join(home, 'profiles/desktop');
  mkdirSync(desktop, { recursive: true });
  writeFileSync(
    join(desktop, 'package.json'),
    JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
  );
  writeFileSync(join(desktop, 'cordis.yml'), '[]');
  const source = stringify([
    {
      id: 'llm-pi-ai',
      config: {
        providers: {
          first: { apiKeyEnv: 'FIRST', models: [{ id: 'first' }] },
          company: { apiKeyEnv: 'COMPANY', models: [{ id: 'first' }, { id: 'chosen' }] },
        },
      },
    },
    { id: 'agent-default-model', config: { provider: 'company', model: 'chosen' } },
  ]);
  writeFileSync(join(desktop, 'cordis.patch.yml'), source);
  const credentials = 'version: 1\nrefs:\n  FIRST: fixture-first\n  COMPANY: fixture-company\n';
  writeFileSync(join(home, '.credentials.yaml'), credentials);
  const launch = resolveDshSetupLaunch(process.execPath, [entry, '--profile', 'acp'], host);
  const inspection = await readDshSetup(launch, 'auto');
  assert.equal(inspection.view.sourceProfile, 'desktop');
  assert.deepEqual(inspection.view.suggestedSelection, { provider: 'company', model: 'chosen' });
  assert.ok(!JSON.stringify(inspection.view).includes('fixture-company'));
  const recommendation = await inspectDshRecommendation(
    { installed: true, acp: { command: process.execPath, startupArgs: [entry, '--profile', 'acp'] } },
    host,
  );
  assert.deepEqual(recommendation, {
    status: 'configured',
    sourceProfile: 'desktop',
    revision: inspection.view.revision,
    provider: 'company',
    model: 'chosen',
  });
  assert.equal(existsSync(join(host, '.cat-cafe/dsh-acp')), false, 'detection does not write a persistent setup');
  const selection = inspection.view.suggestedSelection;
  assert.ok(selection);
  const prepared = await prepareDshSetup(
    launch,
    inspection.view.sourceProfile,
    inspection.view.revision,
    selection.provider,
    selection.model,
  );
  assert.ok(prepared.launch.args.includes('--patch'));
  assert.equal(readFileSync(join(desktop, 'cordis.patch.yml'), 'utf8'), source);
  assert.equal(readFileSync(join(home, '.credentials.yaml'), 'utf8'), credentials);
  assert.equal(existsSync(join(home, 'profiles/acp')), false);
  const otherStore = stringify([{ id: 'credentials', config: { path: join(home, 'private-store.yaml') } }]);
  for (const path of [join(desktop, 'cordis.patch.yml'), join(home, 'cordis.patch.yml')]) {
    writeFileSync(path, path.includes('profiles') ? source + otherStore : otherStore);
    await assert.rejects(readDshSetup(launch, 'desktop'), /custom_startup/);
    assert.equal(readFileSync(path, 'utf8'), path.includes('profiles') ? source + otherStore : otherStore);
    writeFileSync(path, path.includes('profiles') ? source : '[]');
  }
});
