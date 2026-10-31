import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { accountToRuntimeProfile, validateRuntimeProviderBinding } from '../src/config/account-resolver.js';
import { ClaudeAgentService } from '../src/domains/cats/services/agents/providers/ClaudeAgentService.js';
import { ClaudeInteractivePtyCarrierService } from '../src/domains/cats/services/agents/providers/ClaudeInteractivePtyCarrierService.js';
import { CarrierHealthStore } from '../src/domains/cats/services/agents/providers/carrier-health.js';
import { FallbackCarrierWrapper } from '../src/domains/cats/services/agents/providers/claude-carrier-factory.js';
import { prepareClaudeSdkLaunch } from '../src/domains/cats/services/agents/providers/claude-sdk-launch.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

const savedModel = process.env.CAT_OPUS_MODEL;
before(() => {
  process.env.CAT_OPUS_MODEL = 'claude-opus-4-6';
});
after(() => {
  if (savedModel === undefined) delete process.env.CAT_OPUS_MODEL;
  else process.env.CAT_OPUS_MODEL = savedModel;
});
const token = 'sk-ant-oat01-fixture-selected-A';
const selected = { claudeTokenAccount: true, accountEnv: { CLAUDE_CODE_OAUTH_TOKEN: token } };
test('read-only print refuses competing tokens from every settings source before spawning', async (t) => {
  for (const source of ['user', 'project', 'local']) {
    await t.test(source, async () => {
      const root = mkdtempSync(join(tmpdir(), 'f320-readonly-'));
      const saved = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = join(root, 'config');
      mkdirSync(join(root, 'config'));
      mkdirSync(join(root, '.claude'));
      const path =
        source === 'user'
          ? join(root, 'config/settings.json')
          : join(root, '.claude', source === 'local' ? 'settings.local.json' : 'settings.json');
      writeFileSync(path, JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'competing-secret' } }));
      let spawns = 0;
      try {
        const service = new ClaudeAgentService({ l0CompilerFn: fakeL0Compiler });
        const events = [];
        for await (const event of service.invoke('fixture', {
          ...selected,
          workingDirectory: root,
          toolExecutionPolicy: { mode: 'read_only' },
          spawnCliOverride: async function* () {
            spawns++;
          },
        }))
          events.push(event);
        assert.equal(spawns, 0, 'a different credential must never reach the provider');
        assert.match(JSON.stringify(events), /claude_token_settings_conflict/);
        assert.ok(!JSON.stringify(events).includes('competing-secret'));
      } finally {
        if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = saved;
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
test('read-only PTY refuses a competing token before constructing the driver', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f320-readonly-pty-'));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'other' } }));
  let drivers = 0;
  try {
    const service = new ClaudeInteractivePtyCarrierService({
      cwd: root,
      driverFactory: () => {
        drivers++;
        throw new Error('driver must not start');
      },
    });
    await assert.rejects(async () => {
      for await (const _ of service.invoke('fixture', { ...selected, toolExecutionPolicy: { mode: 'read_only' } })) {
      }
    }, /claude_token_settings_conflict/);
    assert.equal(drivers, 0);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
test('account launch rejection cannot degrade carrier health or silently retry another carrier', async () => {
  const store = new CarrierHealthStore();
  let fallbacks = 0;
  const wrapper = new FallbackCarrierWrapper(
    {
      async *invoke() {
        throw new Error('claude_token_carrier_unsupported');
      },
    },
    createCatId('opus'),
    'bg_daemon',
    'bg_daemon',
    store,
    () => {
      fallbacks++;
      return { async *invoke() {} };
    },
  );
  for (let attempt = 0; attempt < 3; attempt++)
    await assert.rejects(async () => {
      for await (const _ of wrapper.invoke('fixture', selected)) {
      }
    }, /claude_token_carrier_unsupported/);
  assert.equal(fallbacks, 0);
  assert.equal(store.getHealth('bg_daemon').state, 'healthy');
  store.reportFailure('bg_daemon', 'structural');
  let launches = 0;
  const alreadyDegraded = new FallbackCarrierWrapper(
    {
      async *invoke() {
        launches++;
      },
    },
    createCatId('opus'),
    'print_sdk',
    'bg_daemon',
    store,
  );
  await assert.rejects(async () => {
    for await (const _ of alreadyDegraded.invoke('fixture', selected)) {
    }
  }, /claude_token_carrier_unsupported/);
  assert.equal(launches, 0, 'a degraded bg target must not silently reroute the account');
});
test('managed Claude secrets are admitted only to the native anthropic client', () => {
  const profile = accountToRuntimeProfile(
    'fixture',
    {
      authType: 'oauth',
      clientId: 'anthropic',
      claude: { kind: 'long_lived_token' },
    },
    { accessToken: token },
  );
  assert.equal(validateRuntimeProviderBinding('anthropic', profile), null);
  for (const client of ['acp', 'catagent', 'openai', 'google', 'kimi', 'opencode'] as const)
    assert.ok(validateRuntimeProviderBinding(client, profile), `${client} must not receive the private token`);
});

test('SDK checks exactly the sources it passes, including its empty read-only source list', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f320-sdk-sources-'));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'other' } }));
  const prepare = (readOnly: boolean) =>
    prepareClaudeSdkLaunch({
      catId: createCatId('opus'),
      model: 'claude-opus-4-6',
      prompt: 'fixture',
      l0CompilerFn: fakeL0Compiler,
      abortController: new AbortController(),
      options: {
        ...selected,
        workingDirectory: root,
        ...(readOnly ? { toolExecutionPolicy: { mode: 'read_only' as const } } : {}),
      },
    });
  try {
    await assert.rejects(prepare(false), /claude_token_settings_conflict/);
    const readOnly = await prepare(true);
    assert.deepEqual(readOnly.sdkOptions.settingSources, []);
    assert.equal(readOnly.sdkOptions.env?.CLAUDE_CODE_OAUTH_TOKEN, token);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
