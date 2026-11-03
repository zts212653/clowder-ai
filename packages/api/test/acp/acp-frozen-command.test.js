import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import { invalidateCliCommand } from '../../dist/utils/cli-resolve.js';

for (const transport of ['stdio', 'httpstream'])
  test(`factory ${transport} pins the program selected from the admitted PATH`, async (t) => {
    const parent = resolve('artifacts/role-agent-refactor/frozen-command');
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, 'owned-'));
    const a = join(root, 'client A'),
      b = join(root, 'client B');
    await Promise.all([mkdir(a), mkdir(b)]);
    const command = `owned-client-${randomUUID()}`;
    const leaf = command + (process.platform === 'win32' ? '.exe' : '');
    await Promise.all([a, b].map((dir) => writeFile(join(dir, leaf), '#!/bin/sh\nexit 0\n', { mode: 0o700 })));
    const previous = process.env.PATH;
    const pools = new Map(),
      services = [],
      clients = [];
    t.after(async () => {
      await Promise.allSettled(clients.map((client) => client.close()));
      await Promise.allSettled(services.map((service) => service.disposeHostService()));
      await Promise.allSettled([...pools.values()].map((pool) => pool.closeAll()));
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    });
    const profileId = 'frozen-command-' + randomUUID();
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
        acpConfig: { command, startupArgs: [], transport, experimental: transport === 'httpstream' },
        log: { info() {}, warn() {}, error() {} },
      });
      assert.ok(service);
      services.push(service);
      await service.captureInvocationOptions({ workingDirectory: root, mcpSupport: false });
      return service;
    };
    const spawn = async () => {
      let selected;
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
        child.stdout.write(JSON.stringify({ id: request.id, result: { agentInfo: { name: 'owned-command' } } }) + '\n');
      });
      const client = pools.get(profileId).clientFactory();
      clients.push(client);
      client.config.spawnFn = (actual) => {
        selected = actual;
        return child;
      };
      if (transport === 'httpstream') {
        client.discoverPort = async () => 12345;
        client.httpRequest = async () => ({ result: { agentInfo: { name: 'owned-http-command' } } });
      }
      await client.initialize();
      await client.close();
      return selected;
    };
    const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
    process.env.PATH = a + delimiter + (previous ?? '');
    await create();
    process.env.PATH = b + delimiter + (previous ?? '');
    invalidateCliCommand(command);
    const selected = await spawn();
    await writeFile(
      join(root, 'evidence.json'),
      JSON.stringify({ selected, expected: join(a, leaf), noOsClientProcess: true }, null, 2),
    );
    assert.equal(normalize(selected), normalize(join(a, leaf)), 'the old admitted task keeps client A');
    await create();
    assert.equal(normalize(await spawn()), normalize(join(b, leaf)), 'the next factory uses current selection B');
  });
