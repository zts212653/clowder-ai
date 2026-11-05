import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');

for (const transport of ['stdio', 'httpstream'])
  test(
    `Windows ${transport} freezes a shim entry and preserves literal argv`,
    { skip: process.platform !== 'win32' },
    async (t) => {
      const parent = resolve('artifacts/role-agent-refactor/frozen-shim');
      await mkdir(parent, { recursive: true });
      const root = await mkdtemp(join(parent, '猫猫 shim '));
      const shim = join(root, 'client.cmd'),
        a = join(root, 'entry-a.js'),
        b = join(root, 'entry-b.js');
      await Promise.all([a, b].map((file) => writeFile(file, '// owned placeholder, never executed\n')));
      await writeFile(shim, '@"%dp0%\\entry-a.js" %*\n');
      const argument = '保留 spaces & "quoted" ^ | tail';
      const pools = new Map(),
        services = [],
        clients = [],
        observations = [];
      t.after(async () => {
        await Promise.allSettled(clients.map((client) => client.close()));
        await Promise.allSettled(services.map((service) => service.disposeHostService()));
        await Promise.allSettled([...pools.values()].map((pool) => pool.closeAll()));
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
      t.mock.method(childProcess, 'spawn', (command, args, options) => {
        observations.push({ command, args, shell: options.shell });
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
          child.stdout.write(JSON.stringify({ id: request.id, result: { agentInfo: { name: 'owned-shim' } } }) + '\n');
        });
        return child;
      });
      syncBuiltinESMExports();
      const profileId = `frozen-shim-${transport}`;
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
          acpConfig: { command: shim, startupArgs: [argument], transport, experimental: transport === 'httpstream' },
          log: { info() {}, warn() {}, error() {} },
        });
        assert.ok(service);
        services.push(service);
        await service.captureInvocationOptions({ workingDirectory: root, mcpSupport: false });
      };
      const spawn = async () => {
        const client = pools.get(profileId).clientFactory();
        clients.push(client);
        if (transport === 'httpstream') {
          client.discoverPort = async () => 12345;
          client.httpRequest = async () => ({ result: { agentInfo: { name: 'owned-http-shim' } } });
        }
        await client.initialize();
        await client.close();
        return observations.at(-1);
      };
      await create();
      await writeFile(shim, '@"%dp0%\\entry-b.js" %*\n');
      const old = await spawn();
      assert.deepEqual(old.args, [a, argument]);
      assert.equal(old.shell, undefined, 'a parsed npm shim runs its script directly with literal argv');
      await create();
      const current = await spawn();
      assert.deepEqual(
        current.args,
        [b, argument],
        'the next factory must refresh a cached shim even while old entry still exists',
      );
      assert.equal(current.shell, undefined);
      await writeFile(
        join(root, 'evidence.json'),
        JSON.stringify({ old, current, noNativeAgentProcess: true }, null, 2),
      );
    },
  );
