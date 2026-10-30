import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { discoverNativeRuntimes } from '../src/routes/native-runtimes.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-tool-catalog-'));
  const home = join(root, 'home');
  const commandFor = (name: string) => join(root, `${name}.exe`);
  mkdirSync(home);
  for (const name of ['codeagent', 'codex', 'claude', 'dsh', 'pi', 'pi-acp', 'kimi'])
    writeFileSync(commandFor(name), 'fixture');
  const template = JSON.parse(readFileSync(new URL('../../../cat-template.json', import.meta.url), 'utf8'));
  template.breeds = [];
  const configs = [
    { id: 'custom-one', command: commandFor('codeagent'), args: ['--acp'], model: 'first-model' },
    {
      id: 'custom-two',
      command: commandFor('codeagent'),
      args: ['--acp', '--permission-mode', 'bypassPermission'],
      model: 'second-model',
    },
    { id: 'other-client', command: commandFor('unknown-acp'), args: ['--acp'], model: 'third-model' },
    { id: 'dsh-existing', command: commandFor('dsh'), args: ['--profile', 'acp'], model: 'saved-dsh-model' },
    {
      id: 'authorized-plugin',
      command: 'plugin-owned-placeholder',
      args: [],
      model: 'plugin-model',
      provider: 'plugin-instance/contribution',
    },
  ];
  for (const config of configs)
    template.breeds.push({
      id: config.id,
      catId: config.id,
      name: config.id,
      displayName: config.id,
      client: 'acp',
      variants: [
        {
          catId: config.id,
          clientId: 'acp',
          defaultModel: config.model,
          ...(config.provider ? { agentProvider: config.provider } : {}),
          acp: { command: config.command, startupArgs: config.args, transport: 'stdio' },
        },
      ],
    });
  writeFileSync(join(root, 'cat-template.json'), JSON.stringify(template));
  const saved = new Map(
    [
      'CAT_TEMPLATE_PATH',
      'CAT_CAFE_GLOBAL_CONFIG_ROOT',
      'CAT_CAFE_CONFIG_ROOT',
      'CODEX_HOME',
      'CLAUDE_CONFIG_DIR',
      'DSH_HOME',
      'PI_CODING_AGENT_DIR',
      'KIMI_CODE_HOME',
      'KIMI_SHARE_DIR',
      'KIMI_CONFIG_FILE',
    ].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    CAT_TEMPLATE_PATH: join(root, 'cat-template.json'),
    CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
    CAT_CAFE_CONFIG_ROOT: root,
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    DSH_HOME: join(home, '.dsh'),
    PI_CODING_AGENT_DIR: join(home, '.pi'),
    KIMI_CODE_HOME: join(home, '.kimi'),
    KIMI_SHARE_DIR: join(home, '.kimi'),
    KIMI_CONFIG_FILE: join(home, '.kimi/config.toml'),
  });
  const original = catRegistry.getAllConfigs();
  catRegistry.reset();
  for (const config of configs)
    catRegistry.register(config.id, {
      id: config.id,
      displayName: `角色 ${config.id}`,
      clientId: 'acp',
      defaultModel: config.model,
      ...(config.provider ? { agentProvider: config.provider } : {}),
    });
  return {
    root,
    home,
    commandFor,
    restore() {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) catRegistry.register(id, config);
      for (const [key, value] of saved)
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    },
  };
}

test('intranet ordinary catalog has five tools and keeps distinct exact bindings outside that catalog', () => {
  const f = fixture();
  try {
    const result = discoverNativeRuntimes(f.root, { home: f.home, commandFor: f.commandFor, intranet: true });
    assert.equal(result.edition, 'intranet');
    assert.deepEqual(
      result.runtimes
        .filter((runtime) => runtime.kind === 'tool')
        .map((runtime) => runtime.harnessId)
        .sort(),
      ['claudecode', 'codeagent', 'codex', 'dsh', 'pi'],
    );
    for (const runtime of result.runtimes.filter((item) => item.kind === 'tool' && item.harnessId !== 'codeagent')) {
      assert.equal('roleTemplates' in runtime, false, 'ordinary tools retain their existing stable identity mapping');
    }
    const bindings = result.runtimes.filter((runtime) => runtime.kind === 'binding');
    assert.deepEqual(bindings.map((runtime) => runtime.id).sort(), [
      'acp:custom-one',
      'acp:custom-two',
      'acp:dsh-existing',
      'acp:other-client',
    ]);
    const first = bindings.find((runtime) => runtime.id === 'acp:custom-one');
    const second = bindings.find((runtime) => runtime.id === 'acp:custom-two');
    assert.equal(first?.sourceCatId, 'custom-one');
    assert.equal(first?.harnessId, 'codeagent');
    assert.equal(second?.harnessId, 'codeagent');
    assert.deepEqual(first?.models, ['first-model']);
    assert.deepEqual(second?.models, ['second-model']);
    assert.deepEqual(second?.acp?.startupArgs, ['--acp', '--permission-mode', 'bypassPermission']);
    assert.equal(bindings.find((runtime) => runtime.id === 'acp:other-client')?.harnessId, undefined);
    assert.ok(
      result.runtimes.find((runtime) => runtime.id === 'dsh' && runtime.kind === 'tool'),
      'an existing DSH member must not hide the tool',
    );
    assert.equal(catRegistry.getAllConfigs()['authorized-plugin']?.agentProvider, 'plugin-instance/contribution');
    assert.equal(
      result.runtimes.some((runtime) => runtime.id === 'acp:authorized-plugin'),
      false,
      'plugin launch authority stays in the existing plugin library',
    );
  } finally {
    f.restore();
  }
});

test('public catalog retains additional tools and does not apply the intranet five-tool filter', () => {
  const f = fixture();
  try {
    const result = discoverNativeRuntimes(f.root, { home: f.home, commandFor: f.commandFor, intranet: false });
    assert.equal(result.edition, 'public');
    assert.ok(result.runtimes.some((runtime) => runtime.id === 'kimi' && runtime.kind === 'tool'));
    assert.equal(result.runtimes.filter((runtime) => runtime.id === 'codeagent').length, 1);
    assert.equal(result.runtimes.find((runtime) => runtime.id === 'claude')?.label, 'Claude Code');
  } finally {
    f.restore();
  }
});

test('ordinary native tool model metadata does not merge independent member or account selections', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.home, '.claude'));
    writeFileSync(join(f.home, '.claude/settings.json'), JSON.stringify({ model: 'native-model' }));
    catRegistry.register('managed-claude-member', {
      id: 'managed-claude-member',
      clientId: 'anthropic',
      defaultModel: 'account-specific-model',
    });
    const result = discoverNativeRuntimes(f.root, { home: f.home, commandFor: f.commandFor, intranet: true });
    assert.deepEqual(result.runtimes.find((runtime) => runtime.id === 'claude')?.models, ['native-model']);
    assert.equal(catRegistry.getAllConfigs()['managed-claude-member']?.defaultModel, 'account-specific-model');
  } finally {
    f.restore();
  }
});

test('Claude discovery inherits its effective native model and effort from the same launch settings', () => {
  const f = fixture();
  const keys = ['ANTHROPIC_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.ANTHROPIC_MODEL = 'shell-model';
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'medium';
    mkdirSync(join(f.home, '.claude'));
    mkdirSync(join(f.root, '.claude'));
    writeFileSync(
      join(f.home, '.claude/settings.json'),
      JSON.stringify({ model: 'user-model', env: { ANTHROPIC_MODEL: 'user-gateway-model' } }),
    );
    writeFileSync(
      join(f.root, '.claude/settings.local.json'),
      JSON.stringify({
        model: 'local-model',
        effortLevel: 'low',
        env: { ANTHROPIC_MODEL: 'local-gateway-model', CLAUDE_CODE_EFFORT_LEVEL: 'high' },
      }),
    );
    const runtime = discoverNativeRuntimes(f.root, { home: f.home, commandFor: f.commandFor }).runtimes.find(
      (item) => item.id === 'claude',
    );
    assert.ok(runtime && 'configuredModel' in runtime && 'configuredEffort' in runtime);
    assert.equal(runtime.configuredModel, 'local-gateway-model');
    assert.equal(runtime.configuredEffort, 'high');
    assert.deepEqual(runtime.models, ['local-gateway-model']);
    assert.doesNotMatch(JSON.stringify(runtime), /ANTHROPIC_MODEL|CLAUDE_CODE_EFFORT_LEVEL/);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    f.restore();
  }
});

test('invalid DSH HOME disables only DSH while public and intranet catalogs keep other tools', () => {
  const f = fixture();
  try {
    process.env.DSH_HOME = 'relative-native-home';
    for (const intranet of [true, false]) {
      const result = discoverNativeRuntimes(f.root, { home: f.home, commandFor: f.commandFor, intranet });
      const dsh = result.runtimes.find((runtime) => runtime.id === 'dsh');
      assert.equal(dsh?.discoveryStatus, 'acp_profile_invalid');
      assert.equal(dsh?.acp, undefined);
      for (const id of ['claude', 'codex'])
        assert.equal(result.runtimes.find((runtime) => runtime.id === id)?.installed, true);
    }
  } finally {
    f.restore();
  }
});

test('blank DSH HOME keeps discovery scoped to the selected native home', () => {
  const f = fixture();
  try {
    const profile = join(f.home, '.dsh/profiles/acp');
    mkdirSync(profile, { recursive: true });
    writeFileSync(
      join(profile, 'package.json'),
      JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-acp-app'] } } }),
    );
    for (const configured of [undefined, '', '   ']) {
      if (configured === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = configured;
      const result = discoverNativeRuntimes(f.root, { home: f.home, commandFor: f.commandFor, intranet: true });
      const dsh = result.runtimes.find((runtime) => runtime.id === 'dsh');
      assert.equal(dsh?.discoveryStatus, 'configured');
      assert.ok(dsh?.acp);
    }
  } finally {
    f.restore();
  }
});
