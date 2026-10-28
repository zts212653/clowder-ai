import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveServersForCat } from '../dist/config/capabilities/capability-orchestrator.js';
import { bindInvocationPluginMcpView } from '../dist/config/capabilities/invocation-plugin-mcp-view.js';
import {
  resolveAcpMcpServers,
  resolveDisabledServerIds,
} from '../dist/domains/cats/services/agents/providers/acp/acp-mcp-resolver.js';

const pluginId = 'dev.clowder.alpha-view';
const capabilityId = `plugin:${pluginId}:native`;
const config = (overrides = {}) => ({
  version: 2,
  capabilities: [
    {
      id: capabilityId,
      pluginId,
      type: 'mcp',
      enabled: true,
      globalEnabled: true,
      source: 'plugin',
      mcpServer: { command: 'node', args: ['/formal/mcp.js'] },
      ...overrides,
    },
    {
      id: 'external',
      type: 'mcp',
      source: 'external',
      enabled: true,
      mcpServer: { command: 'node', args: ['/user/mcp.js'] },
    },
  ],
});
const view = (root, extra = {}) => ({
  entries: [
    {
      capabilityId,
      pluginId,
      isCurrent: () => true,
      server: {
        command: 'node',
        args: [`/${root}/mcp.js`],
        env: { FIXTURE_OWNER: root },
        transport: 'stdio',
        workingDir: `/${root}`,
      },
      ...extra,
    },
  ],
});
const read = async (selected, policy = config(), cat = 'codex', options = {}) => {
  const iterator = bindInvocationPluginMcpView(
    () =>
      (async function* () {
        yield resolveServersForCat(policy, cat, options);
      })(),
    selected,
  );
  return (await iterator.next()).value;
};

test('local activation changes only a registered plugin launch while preserving canonical access decisions', async () => {
  const policy = config({ blockedCats: ['codex'] });
  const before = structuredClone(policy);
  const blocked = await read(view('alpha'), policy);
  assert.equal(blocked[0].enabled, false);
  assert.deepEqual(blocked[0].args, ['/alpha/mcp.js']);
  assert.deepEqual(blocked[1].args, ['/user/mcp.js']);
  assert.deepEqual(policy, before);
  assert.equal((await read(view('alpha'), config({ globalEnabled: false })))[0].enabled, false);
  assert.equal((await read(view('alpha'), config({ enabled: false, globalEnabled: false })))[0].enabled, false);
});

test('explicit owner override remains explicit and an unregistered local contribution adds no capability', async () => {
  const override = { command: 'node', args: ['/explicit/override.js'] };
  assert.deepEqual((await read(view('alpha'), config({ mcpServerOverride: override })))[0].args, override.args);
  const extra = view('alpha');
  extra.entries.push({ ...extra.entries[0], capabilityId: `plugin:${pluginId}:new` });
  assert.equal((await read(extra)).length, 2);
});

test('missing, mismatched or invalidated local activation cannot revive the formal deployment plugin', async () => {
  const ambiguous = view('alpha');
  ambiguous.entries.push(view('other-instance').entries[0]);
  for (const unavailable of [
    { entries: [] },
    view('alpha', { pluginId: 'another.plugin' }),
    view('alpha', { isCurrent: () => false }),
    ambiguous,
  ]) {
    const actual = await read(unavailable);
    assert.equal(actual[0].enabled, false);
    assert.equal(actual[1].enabled, true);
  }
});

test('project policy cannot treat a missing local activation as an enabled formal fallback', async () => {
  const actual = await read({ entries: [] }, config({ blockedCats: [] }), 'codex', { accessScope: 'project' });
  assert.equal(actual[0].enabled, false);
  assert.equal(actual[1].enabled, true);
});

async function readAcp(selected, policy = config()) {
  const iterator = bindInvocationPluginMcpView(
    () =>
      (async function* () {
        yield await resolveAcpMcpServers(process.cwd(), [], undefined, {
          mcpSupport: true,
          catId: 'codex',
          capabilitiesConfig: policy,
          disabledServerIds: resolveDisabledServerIds(process.cwd(), 'codex', policy),
        });
      })(),
    selected,
  );
  return (await iterator.next()).value;
}

test('ordinary ACP discovery selects the same local activation without changing its canonical policy', async () => {
  const servers = await readAcp(view('alpha'));
  const plugin = servers.find((server) => server.name === capabilityId);
  assert.deepEqual(plugin.args, ['/alpha/mcp.js']);
  assert.equal(plugin.env.find((entry) => entry.name === 'FIXTURE_OWNER').value, 'alpha');
  assert.ok(
    (await readAcp(view('alpha'), config({ blockedCats: ['codex'] }))).every((server) => server.name !== capabilityId),
  );
});

test('ACP discovery cannot revive missing or stale local launches through formal declarations', async () => {
  for (const selected of [{ entries: [] }, view('alpha', { isCurrent: () => false })]) {
    const servers = await readAcp(selected);
    assert.deepEqual(
      servers.map((server) => server.name),
      ['external'],
    );
  }
});

test('overlapping member iterators and nested unscoped calls keep their own Host launch view', async () => {
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  let prepared = 0;
  const run = (selected) =>
    bindInvocationPluginMcpView(
      () =>
        (async function* () {
          prepared++;
          if (prepared === 2) release();
          await barrier;
          const unscoped = await read(undefined);
          assert.deepEqual(unscoped[0].args, ['/formal/mcp.js']);
          yield resolveServersForCat(config(), 'codex')[0].args[0];
        })(),
      selected,
    );
  const left = run(view('left')),
    right = run(view('right'));
  const result = await Promise.all([left.next(), right.next()]);
  assert.deepEqual(
    result.map((x) => x.value),
    ['/left/mcp.js', '/right/mcp.js'],
  );
  assert.deepEqual(resolveServersForCat(config(), 'codex')[0].args, ['/formal/mcp.js']);
});

test('provider construction and cancellation cleanup use the same bounded member view', async () => {
  let construction;
  let cleanup;
  const iterator = bindInvocationPluginMcpView(() => {
    construction = resolveServersForCat(config(), 'codex')[0].args;
    return (async function* () {
      try {
        yield 1;
      } finally {
        cleanup = resolveServersForCat(config(), 'codex')[0].args;
      }
    })();
  }, view('alpha'));
  assert.equal((await iterator.next()).value, 1);
  await iterator.return();
  assert.deepEqual(construction, ['/alpha/mcp.js']);
  assert.deepEqual(cleanup, ['/alpha/mcp.js']);
  assert.deepEqual(resolveServersForCat(config(), 'codex')[0].args, ['/formal/mcp.js']);
});
