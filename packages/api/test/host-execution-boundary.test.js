import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  captureHostExecutionBoundary,
  changedHostExecutionBoundary,
  hostExecutionBoundaryRef,
} from '../dist/domains/cats/services/agents/invocation/host-execution-boundary.js';
import { SessionImplementationRegistry } from '../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { registerPluginAgentProvider } from '../dist/domains/cats/services/agents/session-contract/plugin-agent-provider-registration.js';
import { RegisteredSessionAgentService } from '../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';

const binding = {
  catConfig: { clientId: 'acp', avatar: 'display.png' },
  implementation: { key: 'test:codeagent', generation: 'generation-1', compatibilityRevision: 'revision-1' },
  workspace: { workingDirectory: process.cwd(), workingProjectRoot: process.cwd() },
  projectRoot: process.cwd(),
  effectiveAccountRef: 'enterprise-account',
  resolvedAccount: {
    id: 'enterprise-account',
    apiKey: 'private-key-canary',
    accountRevision: 'private-secret-hash',
  },
  accountEnv: { ENTERPRISE_API_KEY: 'private-key-canary' },
  providerOptions: { callbackToken: 'private-callback-canary' },
};

test('the persisted Host projection selects safe facts and never serializes the account or invocation environment', () => {
  const boundary = captureHostExecutionBoundary(binding, 'acp_stdio');
  assert.equal(boundary.clientId, 'acp');
  assert.equal(boundary.accountRef, 'enterprise-account');
  assert.equal(boundary.implementationGeneration, 'revision-1');
  assert.equal(boundary.carrier, 'acp_stdio');
  assert.doesNotMatch(JSON.stringify(boundary), /private-|apiKey|accountRevision|callbackToken|accountEnv/);
  assert.equal(Object.isFrozen(boundary), true);
});

test('hard-boundary changes report their concrete dimension and unknown records remain unknown', () => {
  const before = captureHostExecutionBoundary(binding, 'acp_stdio');
  assert.deepEqual(changedHostExecutionBoundary(undefined, before), ['unknown']);
  for (const [key, value] of [
    ['clientId', 'google'],
    ['carrier', 'acp_http'],
    ['implementationKey', 'test:other'],
    ['implementationGeneration', 'generation-2'],
    ['accountRef', 'other-account'],
    ['workspaceRoot', '/other-workspace'],
    ['projectRoot', '/other-project'],
  ])
    assert.deepEqual(changedHostExecutionBoundary(before, { ...before, [key]: value }), [key]);
});

test('Codex adapter state roots are recorded only from its selected launch descriptor', () => {
  const boundary = captureHostExecutionBoundary(
    {
      ...binding,
      codexAccountLaunch: { stateRoot: 'C:/state-root', accountOwnerRoot: 'C:/account-owner' },
    },
    'native_cli',
  );
  const stateRoot = resolve('C:/state-root');
  const ownerRoot = resolve('C:/account-owner');
  assert.equal(boundary.accountStateRoot, process.platform === 'win32' ? stateRoot.toLowerCase() : stateRoot);
  assert.equal(boundary.accountOwnerRoot, process.platform === 'win32' ? ownerRoot.toLowerCase() : ownerRoot);
});

test('generic adapters do not promote an account profile owner root into a native state root', () => {
  const boundary = captureHostExecutionBoundary(
    {
      ...binding,
      catConfig: { ...binding.catConfig, clientId: 'acp' },
      resolvedAccount: { ...binding.resolvedAccount, accountOwnerRoot: 'C:/generic-owner' },
    },
    'acp_stdio',
  );
  assert.equal(boundary.accountStateRoot, undefined);
  assert.equal(boundary.accountOwnerRoot, undefined);
});

test('the durable audit reference contains no private boundary values', () => {
  const boundary = captureHostExecutionBoundary(binding, 'acp_stdio');
  const ref = hostExecutionBoundaryRef(boundary);
  assert.match(ref, /^host-boundary:v1:[0-9a-f]{64}$/);
  assert.doesNotMatch(ref, /private-|workspace|account|acp_stdio/);
});

test('registry rebuild rotates the live execution token without changing durable compatibility', () => {
  const registry = new SessionImplementationRegistry();
  const ref = { builtin: 'fixture' };
  const service = new RegisteredSessionAgentService({ catId: 'codex', ref, registry });
  const unregister = registry.register(ref, () => ({}), 'package-config-v1');
  const first = service.implementationSnapshot();
  const pinned = service.forInvocation();
  unregister();
  const unregisterNext = registry.register(ref, () => ({}), 'package-config-v1');
  const next = service.implementationSnapshot();
  assert.throws(() => pinned.implementationSnapshot(), /session_host_generation_changed/);
  assert.notEqual(first.generation, next.generation);
  assert.equal(first.compatibilityRevision, next.compatibilityRevision);
  const before = captureHostExecutionBoundary({ ...binding, implementation: first }, 'acp_stdio');
  assert.deepEqual(
    changedHostExecutionBoundary(
      before,
      captureHostExecutionBoundary({ ...binding, implementation: next }, 'acp_stdio'),
    ),
    [],
  );
  unregisterNext();
  registry.register(ref, () => ({}), 'package-config-v2');
  assert.deepEqual(
    changedHostExecutionBoundary(
      before,
      captureHostExecutionBoundary({ ...binding, implementation: service.implementationSnapshot() }, 'acp_stdio'),
    ),
    ['implementationGeneration'],
  );
});

test('plugin reactivation preserves compatibility only for the same package and parsed client definition', () => {
  const registry = new SessionImplementationRegistry();
  const ref = { pluginId: 'dev.client-fixture', contributionId: 'client' };
  const service = new RegisteredSessionAgentService({ catId: 'codex', ref, registry });
  const activate = (packageDigest, command = 'native-client') =>
    registerPluginAgentProvider(registry, {
      pluginId: ref.pluginId,
      packageDigest,
      declaration: { id: ref.contributionId, transport: 'acp', acp: { command, startupArgs: [] } },
      createProvider: () => ({}),
    });
  const first = activate('package-a');
  const original = service.implementationSnapshot();
  first.unregister();
  const same = activate('package-a');
  assert.equal(service.implementationSnapshot().compatibilityRevision, original.compatibilityRevision);
  assert.notEqual(service.implementationSnapshot().generation, original.generation);
  same.unregister();
  const configured = activate('package-a', 'different-client');
  assert.notEqual(service.implementationSnapshot().compatibilityRevision, original.compatibilityRevision);
  configured.unregister();
  activate('package-b');
  assert.notEqual(service.implementationSnapshot().compatibilityRevision, original.compatibilityRevision);
});
