import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  readCapabilitiesConfig,
  resolveServersForCat,
  writeCapabilitiesConfig,
} from '../dist/config/capabilities/capability-orchestrator.js';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { fixture } from './helpers/alpha-plugin-runtime-fixture.js';

test('an owner-enabled new Alpha plugin is discoverable to an ordinary member without a canonical registration', async (t) => {
  const f = await fixture(t, 'alpha');
  const capabilityId = `plugin:${f.pluginId}:native`;
  const config = await readCapabilitiesConfig(f.capabilityProjectRoot);
  await writeCapabilitiesConfig(f.capabilityProjectRoot, {
    ...config,
    capabilities: config.capabilities.filter((entry) => entry.id !== capabilityId),
  });
  const canonical = join(f.capabilityProjectRoot, '.cat-cafe/capabilities.json');
  const before = await readFile(canonical, 'utf8');
  await f.mutate(true);
  const threadStore = new ThreadStore();
  const thread = threadStore.create('fixture-user', 'New local plugin', f.capabilityProjectRoot);
  let observed;
  const deps = {
    registry: {
      create: async () => ({ invocationId: 'new-alpha-plugin-member', callbackToken: 'test-only' }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => undefined,
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => f.capabilityProjectRoot,
    },
    threadStore,
    apiUrl: 'http://127.0.0.1:3004',
    resolveInvocationPluginMcpView: () => f.runtime.supervisor.resolveMemberMcpView(),
  };
  const service = {
    async *invoke() {
      const current = await readCapabilitiesConfig(f.capabilityProjectRoot);
      observed = resolveServersForCat(current, 'codex').find((entry) => entry.capabilityId === capabilityId);
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    },
  };
  for await (const _ of invokeSingleCat(deps, {
    catId: 'codex',
    service,
    prompt: 'Discover the newly installed plugin in this Alpha.',
    userId: 'fixture-user',
    ownerAuthProvenance: 'strict',
    threadId: thread.id,
    isLastCat: true,
    workingDirectory: f.capabilityProjectRoot,
  })) {
    /* Exercise ordinary member discovery without a model or provider request. */
  }
  assert.ok(observed, 'the newly installed local contribution must reach ordinary member discovery');
  assert.equal(observed.enabled, true);
  assert.equal(observed.workingDir.startsWith(f.projectRoot), true);
  assert.equal(await readFile(canonical, 'utf8'), before, 'discovery cannot publish Alpha into shared policy');
  assert.equal(f.writes(), 0);
});
