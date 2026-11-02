import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { parse } from 'yaml';
import {
  dshNativeCredentialMissing,
  prepareDshNativeConfiguration,
  readDshNativeConfiguration,
} from '../src/config/dsh-native-configuration.js';
import { buildCodexServedModelMismatchEvent } from '../src/domains/cats/services/agents/providers/codex-served-model.js';
import { buildDshNativePatch, composeDshProviderSource, inspectDshConfig } from '../src/routes/dsh-setup-config.js';
import { discoverDshRuntime } from '../src/routes/native-dsh-discovery.js';
import { discoverNativeRuntimes } from '../src/routes/native-runtimes.js';
import { nativeConfigurationRevision } from '../src/routes/native-tool-defaults.js';

const source = `- id: llm-pi-ai
  config:
    providers:
      custom-gateway:
        apiKeyEnv: FIXTURE_GATEWAY_KEY
        models: [{ id: custom-model }]
- id: llm-deepseek
  config:
    models: [{ id: native-model, name: Native }]
- id: agent-default-model
  config:
    provider: deepseek-official
    model: native-model
    reasoningEffort: max
`;

test('DSH projects native adapters and the actual default alongside arbitrary custom routes', () => {
  const result = inspectDshConfig(composeDshProviderSource(source, '[]'));
  assert.equal(result.provider, 'deepseek-official');
  assert.equal(result.model, 'native-model');
  assert.deepEqual(result.providers.map((provider) => provider.id).sort(), ['custom-gateway', 'deepseek-official']);
});

test('DSH inherits a built-in adapter default without requiring a redundant user adapter declaration', () => {
  const selection = '- id: agent-default-model\n  config: { provider: deepseek-account, model: selected-native-model }';
  assert.match(buildDshNativePatch(selection), /selected-native-model/);
});

test('DSH exposes the detected native selection explicitly to ACP clients', () => {
  const patch = parse(
    buildDshNativePatch(source, '- id: acp\n  config: { provider: old, model: old, sessionListPageSize: 7 }'),
  ) as Array<{ id: string; config: Record<string, unknown> }>;
  assert.deepEqual(patch.find((entry) => entry.id === 'acp')?.config, {
    provider: 'deepseek-official',
    model: 'native-model',
    sessionListPageSize: 7,
  });
});

test('DSH discovery follows a declared current source rather than an old ACP default', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-inherit-'));
  ['acp', 'desktop'].forEach((profile) => {
    const dir = join(home, 'profiles', profile);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', `@deepseek-ai/dsh-${profile}-app`] } } }),
    );
    writeFileSync(join(dir, 'cordis.yml'), '[]');
  });
  writeFileSync(join(home, 'profiles/desktop/cordis.patch.yml'), source);
  writeFileSync(
    join(home, 'profiles/acp/cordis.patch.yml'),
    '- id: acp\n  config: { provider: retired-route, model: retired-model }',
  );
  const result = discoverDshRuntime({ dshHome: home, npmCaches: [], resolveCommand: () => process.execPath });
  assert.equal(result.configuredModel, '["deepseek-official","native-model"]');
  assert.equal(result.configuredEffort, 'max');
  assert.ok(result.models.includes('["custom-gateway","custom-model"]'));
});

test('native discovery separates tool models from old roles and uses project defaults', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'native-source-'));
  const env = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CAT_CAFE_GLOBAL_CONFIG_ROOT', 'CAT_TEMPLATE_PATH'];
  const previous = env.map((key) => [key, process.env[key]] as const);
  t.after(() =>
    previous.forEach(([key, value]) => (value === undefined ? delete process.env[key] : (process.env[key] = value))),
  );
  ['codex', 'claude', 'project/.claude', 'project/.codex', 'project/.git'].forEach((path) =>
    mkdirSync(join(root, path), { recursive: true }),
  );
  const project = join(root, 'project');
  process.env.CODEX_HOME = join(root, 'codex');
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = project;
  process.env.CAT_TEMPLATE_PATH = join(project, 'cat-template.json');
  writeFileSync(process.env.CAT_TEMPLATE_PATH, JSON.stringify({ version: 1, breeds: [] }));
  writeFileSync(
    join(root, 'codex/config.toml'),
    `model="user-model"\n[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n`,
  );
  writeFileSync(join(project, '.codex/config.toml'), 'model="project-model"\nmodel_reasoning_effort="high"');
  writeFileSync(join(root, 'claude/settings.json'), '{"model":"user-claude"}');
  writeFileSync(join(project, '.claude/settings.local.json'), '{"model":"project-claude"}');
  catRegistry.register('inheritance-old-role', {
    id: 'inheritance-old-role',
    clientId: 'openai',
    defaultModel: 'retired-account-model',
  } as never);
  const runtimes = discoverNativeRuntimes(project, () => null).runtimes;
  assert.equal(runtimes.find((runtime) => runtime.id === 'codex')?.configuredModel, 'project-model');
  assert.equal(runtimes.find((runtime) => runtime.id === 'claude')?.configuredModel, 'project-claude');
  assert.ok(!runtimes.find((runtime) => runtime.id === 'codex')?.models.includes('retired-account-model'));
});

test('inheriting the native Codex default does not claim an upstream model reroute', () => {
  assert.equal(
    buildCodexServedModelMismatchEvent({
      catId: 'fixture',
      requestedModel: '',
      servedModel: 'native-model',
      servedResponseId: 'fixture',
      occurredAt: 0,
    }),
    undefined,
  );
});

test('DSH materializes the current default without writing original profiles and observes changes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-native-launch-'));
  const home = join(root, 'home'),
    profile = join(home, 'profiles/desktop');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), '{}');
  const file = join(profile, 'cordis.patch.yml');
  writeFileSync(file, source);
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => (previous === undefined ? delete process.env.DSH_HOME : (process.env.DSH_HOME = previous)));
  const first = prepareDshNativeConfiguration('dsh', ['--profile', 'acp'], root);
  assert.ok(first);
  assert.equal(first.model, '["deepseek-official","native-model"]');
  assert.match(readFileSync(first.args.at(-1)!, 'utf8'), /reasoningEffort: max/);
  assert.equal(readFileSync(file, 'utf8'), source);
  const revision = nativeConfigurationRevision(root);
  writeFileSync(
    file,
    source
      .replace('provider: deepseek-official', 'provider: custom-gateway')
      .replace('model: native-model', 'model: custom-model'),
  );
  const next = prepareDshNativeConfiguration('dsh', ['--profile', 'acp'], root);
  assert.ok(next);
  assert.notEqual(next.revision, first.revision);
  assert.equal(next.model, '["custom-gateway","custom-model"]');
  assert.notDeepEqual(nativeConfigurationRevision(root), revision);
  assert.equal(prepareDshNativeConfiguration('dsh', ['--profile', 'acp', '--patch', 'explicit.yml'], root), undefined);
});

test('DSH rejects conflicting native defaults and reports missing generic credential references', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-native-conflict-'));
  ['desktop', 'tui'].forEach((name) => {
    const dir = join(root, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(
      join(dir, 'cordis.patch.yml'),
      name === 'desktop' ? source : source.replace('model: native-model', 'model: different'),
    );
  });
  assert.throws(() => readDshNativeConfiguration(root), /dsh_default_ambiguous/);
  writeFileSync(join(root, 'profiles/tui/cordis.patch.yml'), '[]');
  writeFileSync(
    join(root, 'profiles/desktop/cordis.patch.yml'),
    source
      .replace('provider: deepseek-official', 'provider: custom-gateway')
      .replace('model: native-model', 'model: custom-model'),
  );
  const previous = process.env.FIXTURE_GATEWAY_KEY;
  delete process.env.FIXTURE_GATEWAY_KEY;
  t.after(() =>
    previous === undefined ? delete process.env.FIXTURE_GATEWAY_KEY : (process.env.FIXTURE_GATEWAY_KEY = previous),
  );
  assert.equal(dshNativeCredentialMissing(root, root), true);
  writeFileSync(join(root, '.credentials.yaml'), 'refs:\n  FIXTURE_GATEWAY_KEY: fixture-only\n');
  assert.equal(dshNativeCredentialMissing(root, root), false);
});
