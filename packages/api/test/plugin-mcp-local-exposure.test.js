import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  readCapabilitiesConfigState,
  resolveServersForCat,
} from '../dist/config/capabilities/capability-orchestrator.js';
import { bindInvocationPluginMcpView } from '../dist/config/capabilities/invocation-plugin-mcp-view.js';
import { readInvocationMcpConfig } from '../dist/config/capabilities/invoke-mcp-config.js';
import {
  pluginMcpExposureProject,
  projectLocalPluginMcpCapabilities,
} from '../dist/config/capabilities/plugin-mcp-exposure.js';
import { readCapabilitySnapshot } from '../dist/domains/capabilities/capability-read-service.js';
import { resolveAcpMcpServers } from '../dist/domains/cats/services/agents/providers/acp/acp-mcp-resolver.js';

const id = 'plugin:dev.local-music:native';
const config = () => ({ version: 2, capabilities: [] });
const member = (root, cat = 'codex') => ({ kind: 'member', projectRoot: root, memberCatId: cat });
const view = (root, change = {}) => ({
  localCapabilityRoot: root,
  entries: [
    {
      capabilityId: id,
      pluginId: 'dev.local-music',
      installationPolicy: { id, type: 'mcp', source: 'plugin', pluginId: 'dev.local-music', enabled: true },
      policySourceRef: 'plugin-activation:local-instance:1',
      server: { command: 'node', args: ['/local/mcp.js'], env: {}, transport: 'stdio', workingDir: '/local' },
      isCurrent: () => true,
      ...change,
    },
  ],
});

async function rootFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'local-mcp-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.cat-cafe'));
  await writeFile(join(root, '.cat-cafe/capabilities.json'), JSON.stringify(config()));
  return root;
}

test('local policies require a trusted matching project/member and an installed policy, not just a launch', async (t) => {
  const root = await rootFixture(t);
  const policy = config();
  const local = view(root);
  assert.equal(projectLocalPluginMcpCapabilities(policy, local, member(root), 'codex').config.capabilities.length, 1);
  for (const scope of [undefined, member(root, 'other-cat'), member(join(root, 'another-project'))]) {
    assert.equal(projectLocalPluginMcpCapabilities(policy, local, scope, 'codex').config, policy);
  }
  for (const change of [
    { installationPolicy: undefined },
    { policySourceRef: undefined },
    { isCurrent: () => false },
    { installationPolicy: { ...local.entries[0].installationPolicy, source: 'external' } },
    { installationPolicy: { ...local.entries[0].installationPolicy, pluginId: 'another-plugin' } },
  ]) {
    assert.equal(projectLocalPluginMcpCapabilities(policy, view(root, change), member(root), 'codex').config, policy);
  }
  assert.deepEqual(policy, config());
});

test('external missing or malformed project config cannot gain the local plugin through global fallback', async (t) => {
  const root = await rootFixture(t);
  const external = join(root, 'external');
  await mkdir(external);
  assert.equal(pluginMcpExposureProject(external, root), external);
  assert.equal(pluginMcpExposureProject('default', root), root);
  assert.equal(pluginMcpExposureProject(undefined, undefined), undefined);
  for (const malformed of [false, true]) {
    if (malformed) {
      await mkdir(join(external, '.cat-cafe'));
      await writeFile(join(external, '.cat-cafe/capabilities.json'), '{broken');
    }
    const loaded = readInvocationMcpConfig(root, external);
    assert.equal(loaded.accessScope, 'global');
    assert.equal(loaded.configSourceRoot, root);
    const projected = projectLocalPluginMcpCapabilities(loaded.config, view(root), member(external), 'codex');
    assert.equal(projected.localCapabilityIds.size, 0);
    assert.deepEqual(projected.config.capabilities, []);
  }
});

test('canonical refusal, project blockedCats, explicit override and ownership conflicts are never replaced', async (t) => {
  const root = await rootFixture(t);
  for (const change of [
    { globalEnabled: false },
    { blockedCats: ['codex'] },
    { mcpServerOverride: { command: 'explicit-owner-command' } },
    { pluginId: 'another-plugin' },
    { type: 'skill' },
  ]) {
    const entry = { ...view(root).entries[0].installationPolicy, ...change };
    const original = { version: 2, capabilities: [entry] };
    const projected = projectLocalPluginMcpCapabilities(original, view(root), member(root), 'codex');
    assert.equal(projected.config, original);
    assert.equal(projected.config.capabilities[0], entry);
    assert.equal(projected.localCapabilityIds.size, 0);
  }
});

test('ambiguous or invalidated instances expose no new capability', async (t) => {
  const root = await rootFixture(t);
  const local = view(root);
  local.entries.push({ ...local.entries[0], policySourceRef: 'plugin-activation:second-instance:1' });
  assert.equal(projectLocalPluginMcpCapabilities(config(), local, member(root), 'codex').localCapabilityIds.size, 0);
  let current = true;
  const active = view(root, { isCurrent: () => current });
  assert.equal(projectLocalPluginMcpCapabilities(config(), active, member(root), 'codex').localCapabilityIds.size, 1);
  current = false;
  assert.equal(projectLocalPluginMcpCapabilities(config(), active, member(root), 'codex').localCapabilityIds.size, 0);
});

test('encoded name collisions and disjoint contributions from ambiguous plugin instances are denied together', async (t) => {
  const root = await rootFixture(t);
  const first = view(root);
  const original = first.entries[0];
  const otherId = `${id}-second`;
  first.entries.push({
    ...original,
    capabilityId: otherId,
    installationPolicy: { ...original.installationPolicy, id: otherId },
    policySourceRef: 'plugin-activation:another-instance:1',
  });
  assert.equal(projectLocalPluginMcpCapabilities(config(), first, member(root), 'codex').localCapabilityIds.size, 0);
  const collided = view(root);
  collided.entries = ['plugin:dev.a__b:c', 'plugin:dev.a:b__c'].map((capabilityId) => ({
    ...original,
    capabilityId,
    pluginId: capabilityId.split(':')[1],
    installationPolicy: { ...original.installationPolicy, id: capabilityId, pluginId: capabilityId.split(':')[1] },
  }));
  assert.equal(projectLocalPluginMcpCapabilities(config(), collided, member(root), 'codex').localCapabilityIds.size, 0);
});

test('ordinary ACP discovery consumes the same new local installation policy', async (t) => {
  const root = await rootFixture(t);
  const iterator = bindInvocationPluginMcpView(
    () =>
      (async function* () {
        yield await resolveAcpMcpServers(root, [], undefined, {
          mcpSupport: true,
          catId: 'codex',
          capabilitiesConfig: config(),
        });
      })(),
    view(root),
    member(root),
  );
  const servers = (await iterator.next()).value;
  assert.deepEqual(servers.find((entry) => entry.name === id)?.args, ['/local/mcp.js']);
  await iterator.return();
});

test('two Host views remain separate across lazy ordinary provider iterations', async (t) => {
  const root = await rootFixture(t);
  const first = view(root);
  const second = view(root, { server: { ...first.entries[0].server, args: ['/second-host/mcp.js'] } });
  const read = (selected) =>
    bindInvocationPluginMcpView(
      () =>
        (async function* () {
          await Promise.resolve();
          yield resolveServersForCat(config(), 'codex').find((entry) => entry.capabilityId === id);
        })(),
      selected,
      member(root),
    );
  const a = read(first);
  const b = read(second);
  assert.deepEqual((await b.next()).value.args, ['/second-host/mcp.js']);
  assert.deepEqual((await a.next()).value.args, ['/local/mcp.js']);
  await a.return();
  await b.return();
  assert.deepEqual(resolveServersForCat(config(), 'codex'), []);
});

test('read-only diagnostics share the effective policy without exposing runtime values or making it editable', async (t) => {
  const root = await rootFixture(t);
  const state = await readCapabilitiesConfigState(root);
  const before = await readFile(state.path, 'utf8');
  const selected = view(root);
  selected.entries[0].server.env = { CLOWDER_PLUGIN_ACTION_TOKEN: 'fixture-only' };
  const input = { projectRoot: root, mainRoot: root, isProjectView: false, config: state, pluginMcpView: selected };
  const consoleRead = await readCapabilitySnapshot({
    ...input,
    scope: { kind: 'console' },
    secrets: { launchFields: true, values: true },
  });
  const memberRead = await readCapabilitySnapshot({ ...input, scope: { kind: 'member', catId: 'codex' } });
  assert.equal(consoleRead.status, 'present');
  assert.equal(memberRead.status, 'present');
  const item = consoleRead.board.items.find((entry) => entry.id === id);
  assert.ok(item);
  assert.equal(item.accessManagedByPlugin, true);
  assert.equal(item.mcpServer.env, undefined);
  assert.equal(item.mcpServer.command, undefined);
  assert.equal(JSON.stringify(consoleRead).includes('fixture-only'), false);
  assert.equal(
    memberRead.board.items.some((entry) => entry.id === id),
    true,
  );
  assert.equal(consoleRead.envelope.revision, memberRead.envelope.revision);
  assert.ok(consoleRead.envelope.sourceRefs.includes('plugin-activation:local-instance:1'));
  assert.equal(await readFile(state.path, 'utf8'), before);
});
