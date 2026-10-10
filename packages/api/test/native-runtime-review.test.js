import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCodexCarrierTruth } from '../dist/config/codex-cli.js';
import { createAcpServiceForConfig } from '../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';

test('Codex assembly and read model share native defaults while preserving legacy and explicit carriers', () => {
  assert.deepEqual(resolveCodexCarrierTruth(undefined, {}, 'native_tool'), {
    effective: 'app_server',
    source: 'default',
  });
  assert.equal(resolveCodexCarrierTruth('exec_json', {}, 'native_tool').effective, 'exec_json');
  assert.equal(resolveCodexCarrierTruth(undefined, {}).effective, 'exec_json');
  assert.equal(resolveCodexCarrierTruth(undefined, { CAT_CAFE_CODEX_CARRIER: 'app_server' }).effective, 'app_server');
});

test('native ACP applies explicit account env and rotates the process pool on account changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-acp-account-'));
  mkdirSync(join(root, '.cat-cafe'));
  const previous = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  writeFileSync(
    join(root, '.cat-cafe/cat-catalog.json'),
    JSON.stringify({
      version: 2,
      breeds: [],
      roster: {},
      accounts: {
        team: {
          clientId: 'acp',
          authType: 'api_key',
          displayName: 'Team',
          envVars: { DEEPSEEK_API_KEY: '${api_key}' },
        },
        personal: {
          clientId: 'acp',
          authType: 'api_key',
          displayName: 'Personal',
          envVars: { DEEPSEEK_API_KEY: '${api_key}' },
        },
      },
    }),
  );
  writeFileSync(
    join(root, '.cat-cafe/credentials.json'),
    JSON.stringify({ team: { apiKey: 'fake-team' }, personal: { apiKey: 'fake-personal' } }),
  );
  const poolRegistry = new Map();
  const config = {
    id: 'test',
    clientId: 'acp',
    configurationSource: 'native_tool',
    defaultModel: '',
    accountRef: 'team',
  };
  const input = {
    projectRoot: root,
    profileId: 'test',
    config,
    effectiveModel: '',
    acpConfig: { command: 'mock-acp', startupArgs: ['--acp'] },
    poolRegistry,
    log: { info() {}, warn() {} },
  };
  try {
    assert.ok(await createAcpServiceForConfig(input));
    const first = poolRegistry.get('test');
    assert.equal(first.clientFactory().config.env?.DEEPSEEK_API_KEY, 'fake-team');
    let retired = false;
    const retire = first.retireWhenIdle.bind(first);
    first.retireWhenIdle = () => {
      retired = true;
      retire();
    };
    assert.ok(await createAcpServiceForConfig({ ...input, config: { ...config, accountRef: 'personal' } }));
    assert.equal(retired, true);
    assert.notEqual(poolRegistry.get('test'), first);
    assert.equal(poolRegistry.get('test').clientFactory().config.env?.DEEPSEEK_API_KEY, 'fake-personal');
    assert.equal(await createAcpServiceForConfig({ ...input, config: { ...config, accountRef: 'missing' } }), null);
  } finally {
    await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll()));
    if (previous === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previous;
  }
});
