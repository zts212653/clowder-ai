import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { createAcpServiceForConfig } from '../src/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import { ExecutionAdmissionConflict } from '../src/domains/cats/services/agents/registry/AgentServiceUnavailableError.js';

test('native DSH factory pins a derived default and invalidates it before admission after native settings change', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'native-dsh-factory-'));
  const home = join(root, 'home');
  const profile = join(home, 'profiles/desktop');
  const entry = join(root, 'cli/lib/bin.js');
  mkdirSync(profile, { recursive: true });
  mkdirSync(join(root, 'cli/lib'), { recursive: true });
  mkdirSync(join(root, '.cat-cafe'), { recursive: true });
  writeFileSync(join(root, 'cli/package.json'), '{"name":"@deepseek-ai/dsh"}');
  writeFileSync(entry, '// fixture CLI is never launched');
  writeFileSync(join(profile, 'package.json'), '{}');
  const file = join(profile, 'cordis.patch.yml');
  const source =
    '- id: llm-pi-ai\n  config:\n    providers:\n      arbitrary-provider:\n        models: [{ id: first-model }]\n- id: agent-default-model\n  config: { provider: arbitrary-provider, model: first-model }\n';
  writeFileSync(file, source);
  const previous = process.env.DSH_HOME;
  const compatibility = process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY;
  process.env.DSH_HOME = home;
  // This test exercises configuration capture. Native ancestor ACL policy has
  // its own strict tests; CI workspaces can carry an extra build-agent SID.
  process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY = '1';
  t.after(() => (previous === undefined ? delete process.env.DSH_HOME : (process.env.DSH_HOME = previous)));
  t.after(() =>
    compatibility === undefined
      ? delete process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY
      : (process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY = compatibility),
  );
  const pools = new Map();
  const base = catRegistry.tryGet('opus')!.config;
  const input = {
    projectRoot: root,
    profileId: 'dsh-fixture',
    config: {
      ...base,
      id: 'dsh-fixture',
      clientId: 'acp' as const,
      configurationSource: 'native_tool' as const,
      accountRef: undefined,
      defaultModel: '',
    },
    effectiveModel: '',
    acpConfig: { command: process.execPath, startupArgs: [entry, '--profile', 'acp'] },
    poolRegistry: pools,
    bootstrapRoot: join(root, 'bootstrap'),
    log: { info() {}, warn() {} },
  };
  const service = await createAcpServiceForConfig(input);
  assert.ok(service);
  const client = pools.get('dsh-fixture').clientFactory();
  const args = client.config.args as string[];
  const derived = args.filter((arg) => arg.endsWith('.yml')).find((arg) => arg.includes('native-dsh'));
  assert.ok(derived);
  assert.match(readFileSync(derived, 'utf8'), /first-model/);
  assert.equal(readFileSync(file, 'utf8'), source);
  writeFileSync(derived, readFileSync(derived, 'utf8').replaceAll('first-model', 'unexpected-model'));
  await assert.rejects(service.captureInvocationOptions({ mcpSupport: false }), ExecutionAdmissionConflict);
  assert.throws(() => client.config.verifyBootstrapCwd(), /dsh_configuration_changed/);
  writeFileSync(derived, readFileSync(derived, 'utf8').replaceAll('unexpected-model', 'first-model'));
  writeFileSync(file, source.replaceAll('first-model', 'second-model'));
  await assert.rejects(service.captureInvocationOptions({ mcpSupport: false }), ExecutionAdmissionConflict);
  await service.disposeHostService();
  const refreshed = await createAcpServiceForConfig(input);
  assert.ok(refreshed);
  const nextArgs = pools.get('dsh-fixture').clientFactory().config.args as string[];
  const next = nextArgs.find((arg) => arg.includes('native-dsh') && arg.endsWith('.yml'));
  assert.ok(next);
  assert.match(readFileSync(next, 'utf8'), /second-model/);
  await refreshed.disposeHostService();
});
