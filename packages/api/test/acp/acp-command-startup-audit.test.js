import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import { resolveWindowsSpawnPlan } from '../../dist/utils/cli-spawn-win.js';

for (const transport of ['stdio', 'httpstream'])
  test(
    `new ${transport} factory audits its selected shim rather than the previous cached entry`,
    { skip: process.platform !== 'win32' },
    async (t) => {
      const parent = fileURLToPath(new URL('../../artifacts/role-agent-refactor/command-audit/', import.meta.url));
      await mkdir(parent, { recursive: true });
      const root = await mkdtemp(join(parent, 'owned-'));
      const shim = join(root, 'client.cmd'),
        alternate = join(root, 'alternate.js');
      const bridge = fileURLToPath(
        new URL('../../dist/domains/cats/services/agents/providers/pi/pi-acp-bridge.js', import.meta.url),
      );
      const keys = ['ROLE_AGENT_REVIEW_BRIDGE_DIR', 'NODE_OPTIONS', 'NODE_PATH'];
      const previous = keys.map((key) => [key, process.env[key]]);
      process.env.ROLE_AGENT_REVIEW_BRIDGE_DIR = dirname(bridge);
      process.env.NODE_OPTIONS = '';
      process.env.NODE_PATH = '';
      const pools = new Map(),
        services = [];
      t.after(async () => {
        await Promise.allSettled(services.map((service) => service.disposeHostService()));
        await Promise.allSettled([...pools.values()].map((pool) => pool.closeAll()));
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      });
      await writeFile(shim, '@"%ROLE_AGENT_REVIEW_BRIDGE_DIR%\\pi-acp-bridge.js" %*\n');
      await writeFile(alternate, '// owned placeholder, never executed\n');
      const profileId = `audited-shim-${transport}`;
      const config = {
        ...catRegistry.getAllConfigs().codex,
        id: profileId,
        clientId: 'acp',
        mcpSupport: false,
        configurationSource: 'native_tool',
        accountRef: undefined,
      };
      const input = {
        projectRoot: root,
        bootstrapRoot: join(root, 'bootstrap'),
        profileId,
        config,
        effectiveModel: 'fixture-model',
        poolRegistry: pools,
        acpConfig: {
          command: shim,
          startupArgs: ['--pi-command', process.execPath],
          ...(transport === 'httpstream' ? { transport, experimental: true } : {}),
        },
        log: { info() {}, warn() {} },
      };
      const create = async () => {
        const service = await createAcpServiceForConfig(input);
        assert.ok(service);
        services.push(service);
        return pools.get(profileId);
      };
      const original = await create();
      original.clientFactory();
      await writeFile(shim, '@"%dp0%\\alternate.js" %*\n');
      const changed = await create();
      let changedError;
      try {
        changed.clientFactory();
      } catch (error) {
        changedError = error;
      }
      // Control: the same new entry is legal when the startup audit sees its refreshed cache.
      resolveWindowsSpawnPlan(shim, input.acpConfig.startupArgs, { refresh: true });
      const clean = await create();
      const control = clean.clientFactory();
      assert.equal(control.config.preparedSpawn.args[0], alternate);
      await writeFile(
        join(root, 'evidence.json'),
        JSON.stringify(
          {
            changedError: changedError?.message,
            controlEntry: control.config.preparedSpawn.args[0],
            noAgentProcessCreated: true,
          },
          null,
          2,
        ),
      );
      assert.equal(changedError, undefined, 'the new current program must not inherit the old cached startup audit');
    },
  );
