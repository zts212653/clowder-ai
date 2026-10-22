import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installMcpCapability } from '../dist/config/capabilities/capability-mcp-service.js';
import { APPROVAL } from '../dist/scripts/github-approved-source/approved-scope.js';
import {
  assertMcpMountTarget,
  GITHUB_MCP_ID,
  RECOVERY_INSTANCE,
  verifyGitHubMcpMount,
} from '../dist/scripts/github-approved-source/mcp-mount-authority.js';

function fixture() {
  const caps = [
    'messaging.send',
    'plugin.config.read',
    'plugin.state.get',
    'plugin.state.set',
    'schedule.register',
    'secret.read',
    'task.read',
    'task.write',
    'thread.listMetadata',
    'thread.write',
  ];
  return {
    snapshot: {
      instances: [
        {
          pluginId: 'official.github-operations',
          pluginInstanceId: RECOVERY_INSTANCE,
          packageDigest: APPROVAL.archiveDigest,
          lifecycleState: 'installed',
          activationState: 'enabled',
          runtimeState: 'healthy',
        },
      ],
      grants: [{ pluginInstanceId: RECOVERY_INSTANCE, effectiveGrants: caps }],
      packages: [
        {
          pluginId: 'official.github-operations',
          packageDigest: APPROVAL.archiveDigest,
          packageState: 'installed',
          manifest: {
            contributions: [
              {
                id: 'github-tracking',
                type: 'mcp',
                runtime: { transport: 'stdio', entrypoint: 'dist/mcp-entrypoint.js' },
                actions: [{ method: 'github.migration.bind-wait' }],
              },
            ],
          },
        },
      ],
    },
    entry: {
      id: GITHUB_MCP_ID,
      type: 'mcp',
      source: 'plugin',
      pluginId: 'official.github-operations',
      enabled: true,
      mcpServer: {
        command: '/usr/bin/node',
        workingDir: '/fixture/package',
        transport: 'stdio',
        args: ['/fixture/package/dist/mcp-entrypoint.js'],
        env: { CLOWDER_PLUGIN_ACTION_TOKEN: 'a'.repeat(64), CLOWDER_PLUGIN_ACTION_PATH: '/api/plugin-runtime/action' },
      },
    },
  };
}
test('only exact admitted live instance, grant and declared native bridge can be mounted', () => {
  const { snapshot, entry } = fixture();
  assert.equal(verifyGitHubMcpMount(snapshot, entry).entry, entry);
  for (const change of [
    (s) => s.instances.push({ ...s.instances[0] }),
    (s) => (s.instances[0].activationState = 'disabled'),
    (s) => (s.instances[0].packageDigest = 'wrong'),
    (s) => s.grants[0].effectiveGrants.push('thread.readContent'),
    (s) => s.grants[0].effectiveGrants.pop(),
    (s) => (s.packages[0].manifest.contributions[0].actions = []),
  ]) {
    const f = fixture();
    change(f.snapshot);
    assert.throws(() => verifyGitHubMcpMount(f.snapshot, f.entry));
  }
  for (const change of [
    (e) => (e.source = 'external'),
    (e) => e.mcpServer.args.push('--extra'),
    (e) => (e.mcpServer.env.CAT_CAFE_CALLBACK_TOKEN = 'forbidden'),
    (e) => (e.mcpServer.env.CLOWDER_PLUGIN_ACTION_TOKEN = 'guessed'),
    (e) => (e.globalEnabled = false),
  ]) {
    const f = fixture();
    change(f.entry);
    assert.throws(() => verifyGitHubMcpMount(f.snapshot, f.entry));
  }
});
test('owner disablement, foreign ownership and duplicate target entries refuse replacement', () => {
  const { entry } = fixture();
  assertMcpMountTarget([], entry);
  assertMcpMountTarget([entry], entry);
  for (const targets of [
    [{ ...entry, source: 'external' }],
    [{ ...entry, enabled: false }],
    [{ ...entry, mcpServerOverride: { command: '/bin/other' } }],
    [entry, entry],
  ])
    assert.throws(() => assertMcpMountTarget(targets, entry));
});
test('canonical managed installer preserves unrelated capabilities and redacts its opaque transport audit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'github-mcp-mount-fixture-'));
  const { entry } = fixture();
  const unrelated = {
    id: 'keep-me',
    type: 'mcp',
    source: 'external',
    enabled: false,
    mcpServer: { command: '/bin/false' },
  };
  let config = { version: 2, capabilities: [unrelated] };
  const io = {
    readConfig: async () => structuredClone(config),
    writeAndRegenCli: async (next) => {
      config = structuredClone(next);
    },
    withLock: async (work) => work(),
  };
  try {
    await installMcpCapability(directory, entry, io, { userId: 'fixture-owner' });
    assert.deepEqual(config.capabilities[0], unrelated);
    assert.equal(config.capabilities.length, 2);
    assert.deepEqual(config.capabilities[1], entry);
    const audit = await readFile(join(directory, '.cat-cafe/audit.jsonl'), 'utf8');
    assert.ok(!audit.includes('a'.repeat(64)));
    assert.ok(audit.includes('fixture-owner'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
