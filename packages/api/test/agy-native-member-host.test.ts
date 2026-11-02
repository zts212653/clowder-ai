import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PluginManifest } from '@clowder-ai/plugin-contract';
import { decideAgyNativeHookPayload } from '../../../scripts/agy-native-effect-guard.mjs';
import { captureAgyMemberOptions } from '../src/domains/cats/services/agents/providers/agy-native/agy-native-member.js';
import type { PluginRuntimeAdmission } from '../src/domains/plugin/carrier/runtime-carrier.js';
import { activateDeclaredMcp } from '../src/domains/plugin/declared/declared-mcp-resources.js';

test('AGY consumes a declared Host MCP descriptor without renaming its plugin namespace', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agy-host-member-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'package');
  await mkdir(packageRoot);
  await writeFile(join(packageRoot, 'member.mjs'), 'process.exit(0);');
  const manifest: PluginManifest = {
    pluginId: 'dev.clowder.fixture',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Member fixture',
    contributions: [{ type: 'mcp', id: 'player', runtime: { transport: 'stdio', entrypoint: 'member.mjs' } }],
  };
  const packageDigest = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
  const admission: PluginRuntimeAdmission = {
    packageRecord: {
      pluginId: manifest.pluginId,
      version: manifest.version,
      contractVersion: manifest.contractVersion,
      packageDigest,
      manifest,
      signalSchemas: {},
      packageState: 'installed',
      verifiedAt: 1,
      updatedAt: 1,
    },
    instance: {
      pluginInstanceId: 'fixture',
      pluginId: manifest.pluginId,
      packageDigest,
      lifecycleState: 'installed',
      configReadiness: 'ready',
      activationState: 'enabled',
      runtimeState: 'stopped',
      lifecycleRevision: 1,
      installedAt: 1,
      updatedAt: 1,
    },
  };
  const [launch] = await activateDeclaredMcp(admission, {
    projectRoot: root,
    persistCapabilities: false,
    packages: {
      resolveInstalledPackage: async () => ({
        rootDir: packageRoot,
        manifest,
        verifyIntegrity: async () => {},
        release: async () => {},
      }),
    },
    configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
    mcpConfigIO: {
      readConfig: async () => ({ version: 2, capabilities: [] }),
      writeAndRegenCli: async () => assert.fail('member activation must not publish a global MCP'),
      withLock: async (operation) => operation(),
    },
  });
  assert.ok(launch);
  const captured = captureAgyMemberOptions({
    workingDirectory: root,
    signal: new AbortController().signal,
    executionAccount: { accountRef: 'existing', displayName: 'Existing', authType: 'oauth', accountRevision: '1' },
    toolExecutionPolicy: {
      mode: 'plugin_native',
      pluginInstanceId: 'fixture',
      contributionId: 'player',
      memberSession: { sessionId: 'session', generation: 1, executionId: 'execution' },
    },
    pluginNativeLaunch: {
      server: launch.server,
      sandbox: { kind: 'scoped-member', workspaceRoot: root },
      assertCurrent() {},
    },
  });
  assert.deepEqual(captured?.pluginNativeLaunch?.server, launch.server);
  assert.equal(launch.server.name, 'plugin__dev.clowder.fixture__player');
  const call = (serverName: string) =>
    decideAgyNativeHookPayload(
      {
        toolCall: { name: 'call_mcp_tool', args: { ServerName: serverName, ToolName: 'observe', Arguments: {} } },
      },
      { pluginServerName: captured?.pluginNativeLaunch?.server.name },
    );
  assert.equal(call(launch.server.name).decision, 'allow');
  assert.equal(call(`${launch.server.name}-other`).decision, 'deny');
});
