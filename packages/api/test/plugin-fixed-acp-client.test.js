import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import * as parser from '../dist/domains/cats/services/agents/session-contract/plugin-agent-provider.js';
import { resolveAgentClientLibrary } from '../dist/domains/plugin/declared/agent-client-library.js';

const packageRoot = resolve('fixed-package-test');
const declared = {
  id: 'codeagent',
  transport: 'acp',
  configurationKey: 'connection',
  acp: { command: 'codeagent', startupArgs: ['--acp'], permissionPolicy: 'deny' },
};
const context = { packageRoot };
const input = (declaration, stored, defaultValue = '{}') => ({
  declaration,
  packageRoot,
  configuration: { readConfig: async () => stored },
  admission: {
    instance: { pluginInstanceId: 'test' },
    packageRecord: { manifest: { configuration: [{ key: 'connection', kind: 'string', default: defaultValue }] } },
  },
});

test('a fixed ACP client registers from an empty default and shares one stable definition', async () => {
  const parsed = parser.parseAgentProviderDeclaration(declared, context);
  assert.equal(parsed.ok, true);
  const profiles = await resolveAgentClientLibrary(input(parsed.declaration));
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].id, 'codeagent');
  assert.equal(profiles[0].acp.command, 'codeagent');
  const withoutPolicy = { ...declared, acp: { command: 'codeagent', startupArgs: ['--acp'] } };
  assert.equal((await resolveAgentClientLibrary(input(withoutPolicy)))[0].acp.permissionPolicy, 'deny');
});

test('fixed connection overrides preserve argv boundaries without changing identity or allowing package code', async () => {
  const parsed = parser.parseAgentProviderDeclaration(declared, context);
  assert.equal(parsed.ok, true);
  const configured = JSON.stringify({
    command: process.execPath,
    startupArgs: ['--acp', 'two words'],
    permissionPolicy: 'auto_allow',
  });
  const [profile] = await resolveAgentClientLibrary(input(parsed.declaration, configured));
  assert.equal(profile.id, 'codeagent');
  assert.deepEqual(profile.acp.startupArgs, ['--acp', 'two words']);
  for (const invalid of [
    { id: 'changed' },
    { env: { TOKEN: 'bad' } },
    { command: resolve(packageRoot, 'untrusted.js') },
    { transport: 'httpstream' },
  ]) {
    await assert.rejects(resolveAgentClientLibrary(input(parsed.declaration, JSON.stringify(invalid))));
  }
});

test('neither package declaration nor unsaved defaults grant ACP automatic permission approval', async () => {
  await assert.rejects(
    resolveAgentClientLibrary(input({ ...declared, acp: { ...declared.acp, permissionPolicy: 'auto_allow' } })),
    /显式保存/,
  );
  await assert.rejects(
    resolveAgentClientLibrary(input(declared, undefined, '{"permissionPolicy":"auto_allow"}')),
    /显式保存/,
  );
  const [profile] = await resolveAgentClientLibrary(input(declared, '{"permissionPolicy":"auto_allow"}'));
  assert.equal(profile.acp.permissionPolicy, 'auto_allow');
});
