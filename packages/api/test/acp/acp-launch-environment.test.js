import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import { ExecutionAdmissionConflict } from '../../dist/domains/cats/services/agents/registry/AgentServiceUnavailableError.js';

for (const transport of ['stdio', 'httpstream'])
  test(`factory ${transport} cold spawn keeps admitted environment and refreshes the next pool`, async (t) => {
    const marker = 'ROLE_AGENT_LAUNCH_MARKER';
    const lifecycleKey = 'CAT_CAFE_EXECUTION_ID';
    const previous = process.env[marker];
    const previousLifecycle = process.env[lifecycleKey];
    const parent = resolve('artifacts/role-agent-refactor/acp-launch-environment');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'owned-'));
    const pools = new Map(),
      services = [],
      clients = [];
    t.after(async () => {
      await Promise.allSettled(clients.map((client) => client.close()));
      await Promise.allSettled(services.map((service) => service.disposeHostService()));
      await Promise.allSettled([...pools.values()].map((pool) => pool.closeAll()));
      if (previous === undefined) delete process.env[marker];
      else process.env[marker] = previous;
      if (previousLifecycle === undefined) delete process.env[lifecycleKey];
      else process.env[lifecycleKey] = previousLifecycle;
    });
    const profileId = `launch-environment-${transport}`;
    const config = {
      ...catRegistry.getAllConfigs().codex,
      id: profileId,
      clientId: 'acp',
      configurationSource: 'native_tool',
      accountRef: undefined,
      mcpSupport: false,
    };
    const create = async () => {
      const service = await createAcpServiceForConfig({
        projectRoot: root,
        bootstrapRoot: join(root, 'bootstrap'),
        profileId,
        config,
        effectiveModel: 'fixture-model',
        poolRegistry: pools,
        acpConfig: { command: process.execPath, startupArgs: [], transport, experimental: transport === 'httpstream' },
        log: { info() {}, warn() {}, error() {} },
      });
      assert.ok(service);
      services.push(service);
      return service;
    };
    const observeColdSpawn = async () => {
      const client = pools.get(profileId).clientFactory();
      clients.push(client);
      let observed;
      const child = Object.assign(new EventEmitter(), {
        pid: 12345,
        killed: false,
        exitCode: null,
        signalCode: null,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill() {
          this.killed = true;
          this.emit('exit', 0, null);
          return true;
        },
      });
      child.stdin.on('data', (chunk) => {
        const request = JSON.parse(chunk.toString());
        child.stdout.write(`${JSON.stringify({ id: request.id, result: { agentInfo: { name: 'owned-launch' } } })}\n`);
      });
      client.config.spawnFn = (_command, _args, options) => {
        observed = options.env?.[marker];
        return child;
      };
      if (transport === 'httpstream') {
        client.discoverPort = async () => 12345;
        client.httpRequest = async () => ({ result: { agentInfo: { name: 'owned-launch-http' } } });
      }
      await client.initialize();
      await client.close();
      return observed;
    };
    process.env[marker] = 'admitted';
    const first = await create();
    const pending = first.captureInvocationOptions({ workingDirectory: root, mcpSupport: false });
    process.env[marker] = 'changed-during-capture';
    await assert.rejects(pending, ExecutionAdmissionConflict);
    process.env[marker] = 'admitted';
    await first.captureInvocationOptions({ workingDirectory: root, mcpSupport: false });
    const firstPool = pools.get(profileId);
    assert.equal(
      firstPool.spawnSignature.includes('admitted'),
      false,
      'pool diagnostics do not serialize ambient values',
    );
    process.env[lifecycleKey] = 'transient-invocation-2';
    await first.captureInvocationOptions({ workingDirectory: root, mcpSupport: false });
    const equivalent = await create();
    await equivalent.captureInvocationOptions({ workingDirectory: root, mcpSupport: false });
    assert.equal(pools.get(profileId) === firstPool, true, 'stripped lifecycle inputs do not rebuild a process pool');
    process.env[marker] = 'changed-after-admission';
    assert.equal(await observeColdSpawn(), 'admitted', 'cold start must not merge the new ambient environment');
    await assert.rejects(
      first.captureInvocationOptions({ workingDirectory: root, mcpSupport: false }),
      ExecutionAdmissionConflict,
    );
    const next = await create();
    await next.captureInvocationOptions({ workingDirectory: root, mcpSupport: false });
    assert.equal(
      pools.get(profileId) !== firstPool,
      true,
      'different effective launch environment retires the old pool',
    );
    assert.equal(await observeColdSpawn(), 'changed-after-admission');
  });
