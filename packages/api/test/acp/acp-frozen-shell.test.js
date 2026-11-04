import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';

const require = createRequire(import.meta.url);
const fs = require('node:fs'),
  cp = require('node:child_process');
for (const transport of ['stdio', 'httpstream'])
  test(
    `factory ${transport} freezes the actual cmd shell selected before admission`,
    { skip: process.platform !== 'win32' },
    async (t) => {
      const parent = fileURLToPath(new URL('../../artifacts/role-agent-refactor/frozen-shell/', import.meta.url));
      await mkdir(parent, { recursive: true });
      const root = await mkdtemp(join(parent, 'owned-'));
      const command = join(root, 'client.bat');
      await writeFile(command, '@echo off\r\nrem synthetic placeholder, never executed\r\n');
      const a = join(root, 'shell A', 'cmd.exe'),
        b = join(root, 'shell B', 'cmd.exe');
      const previous = process.env.ComSpec;
      const pools = new Map(),
        clients = [],
        services = [],
        normalized = [];
      const realExists = fs.existsSync,
        realExec = cp.execSync;
      // Exercise a valid Windows machine without Git Bash, while retaining real Node normalization.
      t.mock.method(fs, 'existsSync', (path) => (/[\\/]bash\.exe$/i.test(String(path)) ? false : realExists(path)));
      t.mock.method(cp, 'execSync', (command, options) => {
        if (command === 'where bash') throw new Error('owned fixture has no Git Bash');
        return realExec(command, options);
      });
      t.mock.method(cp.ChildProcess.prototype, 'spawn', function (options) {
        normalized.push({ file: options.file, args: options.args });
        this._handle?.close();
        this._handle = null;
        this.pid = 424242;
        this.stdin = new PassThrough();
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        this.kill = () => {
          this.killed = true;
          this.emit('exit', 0, null);
          return true;
        };
        this.stdin.on('data', (chunk) => {
          const request = JSON.parse(chunk.toString());
          this.stdout.write(JSON.stringify({ id: request.id, result: { agentInfo: { name: 'owned-shell' } } }) + '\n');
        });
        return 0;
      });
      syncBuiltinESMExports();
      t.after(async () => {
        await Promise.allSettled(clients.map((client) => client.close()));
        await Promise.allSettled(services.map((service) => service.disposeHostService()));
        await Promise.allSettled([...pools.values()].map((pool) => pool.closeAll()));
        t.mock.restoreAll();
        syncBuiltinESMExports();
        if (previous === undefined) delete process.env.ComSpec;
        else process.env.ComSpec = previous;
      });
      process.env.ComSpec = a;
      const profileId = `command-shell-${transport}`;
      const service = await createAcpServiceForConfig({
        projectRoot: root,
        bootstrapRoot: join(root, 'bootstrap'),
        profileId,
        config: {
          ...catRegistry.getAllConfigs().codex,
          id: profileId,
          clientId: 'acp',
          configurationSource: 'native_tool',
          accountRef: undefined,
          mcpSupport: false,
        },
        effectiveModel: 'fixture-model',
        poolRegistry: pools,
        acpConfig: {
          command,
          startupArgs: ['spaces & literal'],
          ...(transport === 'httpstream' ? { transport, experimental: true } : {}),
        },
        log: { info() {}, warn() {} },
      });
      assert.ok(service);
      services.push(service);
      await service.captureInvocationOptions({ workingDirectory: root, mcpSupport: false });
      const client = pools.get(profileId).clientFactory();
      clients.push(client);
      process.env.ComSpec = b;
      if (transport === 'httpstream') {
        client.discoverPort = async () => 12345;
        client.httpRequest = async () => ({ result: { agentInfo: { name: 'owned-shell-http' } } });
      }
      await client.initialize();
      await client.close();
      const actual = normalized.at(-1);
      await writeFile(
        join(root, 'evidence.json'),
        JSON.stringify({ expectedShell: a, actualShell: actual.file, noNativeAgentProcessCreated: true }, null, 2),
      );
      assert.equal(actual.file, a, 'the shell executable must come from the admitted plan rather than live ComSpec');
    },
  );
