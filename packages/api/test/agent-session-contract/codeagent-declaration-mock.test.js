import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import { AcpSessionProvider } from '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js';
import { SessionImplementationRegistry } from '../../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import {
  parseAgentProviderDeclaration,
  parsePluginAgentRef,
  resolveMemberSessionRef,
} from '../../dist/domains/cats/services/agents/session-contract/plugin-agent-provider.js';
import { registerPluginAgentProvider } from '../../dist/domains/cats/services/agents/session-contract/plugin-agent-provider-registration.js';
import { RegisteredSessionAgentService } from '../../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { collect } from './fake-session-provider.js';

const pluginId = 'local.codeagent-contract-fixture';
const contribution = { id: 'codeagent', transport: 'acp', acp: { command: 'codeagent', startupArgs: ['--acp'] } };
const packageRoot = resolve('artifacts/role-agent-refactor/codeagent-declaration-package');

test('the accepted CodeAgent contribution is strict and distinct from iCode and malformed explicit references', () => {
  const parsed = parseAgentProviderDeclaration(contribution, { packageRoot });
  assert.deepEqual(parsed, { ok: true, declaration: contribution });
  for (const key of ['clientId', 'launchCommand', 'capabilities', 'supportsSystemPrompt']) {
    assert.equal(parseAgentProviderDeclaration({ ...contribution, [key]: true }, { packageRoot }).ok, false);
  }
  assert.deepEqual(parsePluginAgentRef(`plugin:${pluginId}/codeagent`), { pluginId, contributionId: 'codeagent' });
  assert.notDeepEqual(
    parsePluginAgentRef(`plugin:${pluginId}/codeagent`),
    parsePluginAgentRef(`plugin:${pluginId}/icode`),
  );
  assert.deepEqual(resolveMemberSessionRef('plugin:bad reference', { builtin: 'codex' }), {
    pluginId: '!invalid',
    contributionId: '!invalid',
  });
});

test(
  'CodeAgent declaration → registered Host adapter → real mock: two turns, resume and no fallback',
  { timeout: 20000 },
  async (t) => {
    const parent = resolve('artifacts/role-agent-refactor/codeagent-declaration');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, '独立 状态 '));
    const state = join(root, 'native-state');
    mkdirSync(state);
    const mock = fileURLToPath(new URL('../fixtures/codeagent-mock.mjs', import.meta.url));
    // An explicitly installed external executable is allowed; no package code or shell alias is loaded.
    const parsed = parseAgentProviderDeclaration(
      { ...contribution, acp: { command: process.execPath, startupArgs: [mock, '--acp', '--state-dir', state] } },
      { packageRoot },
    );
    assert.equal(parsed.ok, true);
    const pools = new Map();
    const registry = new SessionImplementationRegistry();
    const catId = 'mock-review-partner';
    const ref = parsePluginAgentRef(`plugin:${pluginId}/codeagent`);
    const bridge = new RegisteredSessionAgentService({ catId, ref, registry });
    const trackedPids = new Set();
    const recordPath = join(root, 'instance.json');
    const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const record = {
      task: 'role-agent-refactor-20261029-gpt-sol',
      owner: 'codex',
      mock: true,
      case: t.name,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      sourceDirty:
        execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim().length > 0,
      testSha256: sha(fileURLToPath(import.meta.url)),
      fixture: mock,
      fixtureSha256: sha(mock),
      executable: process.execPath,
      executableSha256: sha(process.execPath),
      nodeVersion: process.version,
      programDirectory: fileURLToPath(new URL('../../dist/', import.meta.url)),
      compiledFactorySha256: sha(
        new URL('../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js', import.meta.url),
      ),
      dataDirectory: root,
      nativeStateRoot: state,
      binding: `plugin:${pluginId}/codeagent`,
      ownerPid: process.pid,
      startedAt: new Date().toISOString(),
      networkUsed: false,
      nativeCredentialsUsed: false,
      ports: [],
      retention: 'current contract evidence; data retained',
    };
    const save = (status) => {
      pools.forEach((pool) => {
        pool.getActivePids().forEach((pid) => {
          trackedPids.add(pid);
        });
      });
      writeFileSync(recordPath, JSON.stringify({ ...record, pids: [...trackedPids], status }, null, 2));
    };
    save('starting');
    t.after(async () => {
      save('stopping');
      const released = await Promise.allSettled([bridge.releaseAll('test_complete')]);
      const closed = await Promise.allSettled([...pools.values()].map((pool) => pool.closeAll()));
      const runningPids = [...pools.values()].flatMap((pool) => pool.getActivePids());
      const failures = [...released, ...closed].filter((result) => result.status === 'rejected');
      writeFileSync(
        recordPath,
        JSON.stringify(
          {
            ...record,
            pids: [...trackedPids],
            runningPids,
            status: failures.length ? 'cleanup-unconfirmed-data-retained' : 'closed-data-retained',
            stoppedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      assert.deepEqual(failures, []);
      assert.deepEqual(runningPids, []);
    });
    const service = await createAcpServiceForConfig({
      projectRoot: root,
      bootstrapRoot: join(root, 'bootstrap'),
      profileId: catId,
      config: { id: catId, clientId: 'acp', configurationSource: 'native_tool', defaultModel: '', mcpSupport: false },
      effectiveModel: '',
      acpConfig: parsed.declaration.acp,
      poolRegistry: pools,
      log: { info() {}, warn() {} },
    });
    assert.ok(service);
    const registration = registerPluginAgentProvider(registry, {
      pluginId,
      declaration: parsed.declaration,
      createProvider: (declaration, ctx) => {
        assert.equal(declaration.id, 'codeagent');
        assert.equal(ctx.catId, catId);
        return new AcpSessionProvider({ catId, service });
      },
    });
    t.after(() => registration.unregister());
    const options = (extra = {}) => ({
      invocationId: randomUUID(),
      hostSessionId: 'mock-host-session',
      systemPrompt: 'Identity: independent review partner.',
      workingDirectory: root,
      ...extra,
    });
    const first = await collect(bridge.invoke('first task', options()));
    save('running');
    assert.ok(first.every((message) => message.catId === catId));
    assert.ok(first.some((message) => message.content?.includes('Identity: independent review partner.')));
    const id = first.find((message) => message.type === 'session_init')?.sessionId;
    assert.ok(id);
    assert.ok(!first.some((message) => message.type === 'error'));
    const second = await collect(bridge.invoke('second task', options()));
    assert.ok(second.some((message) => message.content?.includes('previous=Identity: independent review partner.')));
    assert.deepEqual(JSON.parse(readFileSync(join(state, `${id}.json`), 'utf8')).length, 2);
    const resumed = await collect(
      bridge.invoke('third task', options({ hostSessionId: 'new-host-session', sessionId: id })),
    );
    assert.ok(resumed.some((message) => message.content?.includes('second task')));
    assert.equal(resumed.find((message) => message.type === 'session_init')?.sessionId, id);
    const before = readdirSync(state);
    registration.unregister();
    const unavailable = await collect(bridge.invoke('must not be sent', options()));
    assert.deepEqual(
      unavailable.map((message) => [message.type, message.errorCode]),
      [
        ['error', 'session_implementation_unavailable'],
        ['done', 'session_implementation_unavailable'],
      ],
    );
    assert.deepEqual(readdirSync(state), before);
    assert.equal(JSON.parse(readFileSync(join(state, `${id}.json`), 'utf8')).length, 3);
  },
);
