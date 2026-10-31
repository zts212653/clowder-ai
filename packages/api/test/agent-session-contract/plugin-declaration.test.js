import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionImplementationRegistry } from '../../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { parseAgentProviderDeclaration as parse } from '../../dist/domains/cats/services/agents/session-contract/plugin-agent-provider.js';
import { registerPluginAgentProvider as register } from '../../dist/domains/cats/services/agents/session-contract/plugin-agent-provider-registration.js';
import { readSessionContractSettings as settings } from '../../dist/domains/cats/services/agents/session-contract/session-contract-settings.js';

const root = '/tmp/package';
const declaration = () => ({ id: 'agent', transport: 'acp', acp: { command: 'node', startupArgs: [] } });
const rows = [
  [null, 'invalid_declaration'],
  [[], 'invalid_declaration'],
  [new Date(), 'invalid_declaration'],
  [{ ...declaration(), entrypoint: 'evil.js' }, 'invalid_declaration'],
  [{ ...declaration(), factory: 'evil' }, 'invalid_declaration'],
  [{ ...declaration(), module: 'evil' }, 'invalid_declaration'],
  [{ ...declaration(), id: '' }, 'invalid_declaration'],
  [{ ...declaration(), id: 'A' }, 'invalid_declaration'],
  [{ ...declaration(), id: 'a'.repeat(65) }, 'invalid_declaration'],
  [{ ...declaration(), transport: 1 }, 'invalid_declaration'],
  [{ ...declaration(), transport: 'a2a' }, 'transport_not_allowed'],
  [{ ...declaration(), acp: [] }, 'invalid_declaration'],
  ...[
    { command: '', startupArgs: [] },
    { command: 'node' },
    { command: 'node', startupArgs: [1] },
    { command: 'node', startupArgs: [], mcpWhitelist: [false] },
    { command: 'node', startupArgs: [], env: {} },
  ].map((acp) => [{ ...declaration(), acp }, 'invalid_declaration']),
  ...['./run', '../run', 'dir/run', 'dir\\run', `${root}/run`, root, `${root}/../package/run`].map((command) => [
    { ...declaration(), acp: { command, startupArgs: [] } },
    'package_command_forbidden',
  ]),
  [{ ...declaration(), acp: { command: 'node', startupArgs: [`${root}/script.mjs`] } }, 'package_command_forbidden'],
];
for (const [value, code] of rows)
  test(`declaration refuses ${JSON.stringify(value)}`, () => {
    assert.equal(parse(value, { packageRoot: root }).code, code);
  });
for (const command of ['node', '/usr/bin/node', '/tmp/package-sibling/agent'])
  test(`declaration allows installed command ${command}`, () => {
    const raw = {
      ...declaration(),
      id: 'a.b_-0',
      acp: { command, startupArgs: ['/outside/script.mjs'], mcpWhitelist: ['tools'] },
    };
    assert.deepEqual(parse(raw, { packageRoot: root }), { ok: true, declaration: raw });
  });
test('validation order: unknown field precedes transport; invalid ACP precedes package path', () => {
  assert.equal(
    parse({ ...declaration(), transport: 'a2a', entrypoint: 'x' }, { packageRoot: root }).code,
    'invalid_declaration',
  );
  assert.equal(
    parse({ ...declaration(), acp: { command: `${root}/x` } }, { packageRoot: root }).code,
    'invalid_declaration',
  );
});
for (const mode of [undefined, '', 'off', 'plugin', 'PLUGIN', ' plugin', 'acp', 'on'])
  test(`settings mode ${JSON.stringify(mode)}`, () => {
    const result = settings({ CAT_CAFE_AGENT_SESSION_CONTRACT: mode });
    assert.equal(result.mode, [undefined, '', 'plugin'].includes(mode) ? 'plugin' : 'off');
    assert.equal(result.warnings.length, mode && !['off', 'plugin'].includes(mode) ? 1 : 0);
  });
test('off never reads bindings, even through a throwing property getter', () => {
  const env = {
    CAT_CAFE_AGENT_SESSION_CONTRACT: 'off',
    get CAT_CAFE_AGENT_SESSION_BINDINGS() {
      throw new Error('read');
    },
  };
  assert.equal(settings(env).bindings.size, 0);
});
for (const raw of ['{', 'null', '[]', '42', '"x"'])
  test(`bad binding JSON ${raw}`, () => {
    const result = settings({ CAT_CAFE_AGENT_SESSION_CONTRACT: 'plugin', CAT_CAFE_AGENT_SESSION_BINDINGS: raw });
    assert.equal(result.bindings.size, 0);
    assert.equal(result.warnings.length, 1);
  });
test('bindings retain valid rows and warn separately for every invalid row', () => {
  const result = settings({
    CAT_CAFE_AGENT_SESSION_CONTRACT: 'plugin',
    CAT_CAFE_AGENT_SESSION_BINDINGS: JSON.stringify({
      valid: 'plugin:company/agent',
      builtin: 'builtin:agent',
      empty: 'plugin:/x',
      slash: 'plugin:a/b/c',
      number: 1,
    }),
  });
  assert.deepEqual([...result.bindings], [['valid', { pluginId: 'company', contributionId: 'agent' }]]);
  assert.equal(result.warnings.length, 4);
});
test('registration caches per cat, rejects duplicates, unregisters idempotently and recreates on restart', () => {
  const registry = new SessionImplementationRegistry();
  const ref = { pluginId: 'company', contributionId: 'agent' };
  let creations = 0;
  const input = {
    pluginId: 'company',
    declaration: declaration(),
    createProvider: (raw, ctx) => {
      assert.equal(raw.id, 'agent');
      creations++;
      return { catId: ctx.catId };
    },
  };
  const first = register(registry, input);
  assert.equal(first.key, 'plugin:company/agent');
  const original = registry.resolve(ref, { catId: 'codex' });
  assert.equal(registry.resolve(ref, { catId: 'codex' }), original);
  assert.notEqual(registry.resolve(ref, { catId: 'opus' }), original);
  assert.equal(creations, 2);
  assert.throws(() => register(registry, input), /Duplicate/);
  first.unregister();
  first.unregister();
  assert.equal(registry.resolve(ref, { catId: 'codex' }), undefined);
  const second = register(registry, input);
  assert.notEqual(registry.resolve(ref, { catId: 'codex' }), original);
  first.unregister();
  assert.ok(registry.has(ref));
  second.unregister();
});
