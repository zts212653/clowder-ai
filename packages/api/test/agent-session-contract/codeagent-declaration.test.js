/**
 * C21 — CodeAgent is declared through the existing strict agent-provider.json
 * schema. The plan's minimal declaration parses; top-level capability fields
 * the schema does not own are refused; a broken explicit member reference stays
 * an explicit (unresolvable) choice instead of falling back to iCode or a
 * native client.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { parseAgentProviderDeclaration, parsePluginAgentRef, resolveMemberSessionRef } = await import(
  '../../dist/domains/cats/services/agents/session-contract/plugin-agent-provider.js'
);

const ctx = { packageRoot: '/opt/plugins/codeagent' };
/** Verbatim from 客户端适配与CodeAgent扩展.md §5.2. */
const CODEAGENT = { id: 'codeagent', transport: 'acp', acp: { command: 'codeagent', startupArgs: ['--acp'] } };

test('C21: the minimal CodeAgent declaration parses unchanged and gains no iCode dialect', () => {
  const result = parseAgentProviderDeclaration(structuredClone(CODEAGENT), ctx);
  assert.equal(result.ok, true);
  assert.deepEqual(result.declaration, CODEAGENT);
  assert.equal('protocolAdapter' in result.declaration.acp, false, 'CodeAgent must not be mapped onto iCode');
});

test('C21: optional mcpWhitelist is accepted inside acp', () => {
  const result = parseAgentProviderDeclaration(
    { ...CODEAGENT, acp: { ...CODEAGENT.acp, mcpWhitelist: ['cat-cafe'] } },
    ctx,
  );
  assert.equal(result.ok, true);
});

for (const field of ['clientId', 'launchCommand', 'capabilities', 'supportsSystemPrompt'])
  test(`C21: top-level "${field}" is refused by the strict schema`, () => {
    const result = parseAgentProviderDeclaration({ ...CODEAGENT, [field]: field === 'capabilities' ? {} : 'x' }, ctx);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_declaration');
  });

for (const field of ['protocolAdapter', 'supportsSystemPrompt', 'autoApprove'])
  test(`C21: acp."${field}" is refused — capabilities come from the Host adapter, not the declaration`, () => {
    const result = parseAgentProviderDeclaration({ ...CODEAGENT, acp: { ...CODEAGENT.acp, [field]: true } }, ctx);
    assert.equal(result.ok, false);
  });

test('C21: a declaration may not launch a script shipped inside the plugin package', () => {
  const result = parseAgentProviderDeclaration(
    { ...CODEAGENT, acp: { command: 'node', startupArgs: ['/opt/plugins/codeagent/run.js'] } },
    ctx,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'package_command_forbidden');
});

test('C21: member reference plugin:<pluginId>/<contributionId> resolves; a bad explicit one never falls back', () => {
  assert.deepEqual(parsePluginAgentRef('plugin:intranet-codeagent/codeagent'), {
    pluginId: 'intranet-codeagent',
    contributionId: 'codeagent',
  });
  const legacy = { pluginId: 'legacy', contributionId: 'icode' };
  for (const bad of ['codeagent', 'plugin:Bad/x', 'plugin:a', 42]) {
    assert.deepEqual(
      resolveMemberSessionRef(bad, legacy),
      { pluginId: '!invalid', contributionId: '!invalid' },
      `explicit invalid ref ${JSON.stringify(bad)} must stay invalid, not become the legacy/iCode binding`,
    );
  }
  assert.equal(resolveMemberSessionRef(null, legacy), undefined, 'null = explicit native/manual carrier');
  assert.deepEqual(resolveMemberSessionRef(undefined, legacy), legacy, 'absent keeps legacy migration binding');
});
