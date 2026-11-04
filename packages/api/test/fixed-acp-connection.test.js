import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { createAcpPoolSpawnSignature } from '../dist/domains/cats/services/agents/providers/acp/acp-pool-signature.js';
import {
  parseAgentProviderConfiguration,
  parseAgentProviderDeclaration,
} from '../dist/domains/cats/services/agents/session-contract/plugin-agent-provider.js';
import { resolveAgentClientLibrary } from '../dist/domains/plugin/declared/agent-client-library.js';
import { writePluginConfig } from '../dist/domains/plugin/plugin-config-store.js';
import { rootRecoveryFixture } from './helpers/acp-root-recovery-fixture.js';

const packageRoot = process.cwd();
const declaration = {
  id: 'codeagent',
  transport: 'acp',
  configurationKey: 'connection',
  acp: { command: 'codeagent', startupArgs: ['--acp'], permissionPolicy: 'deny' },
};
const admission = {
  instance: { pluginInstanceId: 'fixture-instance' },
  packageRecord: {
    manifest: {
      configuration: [{ key: 'connection', kind: 'string', default: '{}' }],
    },
  },
};

test('a fixed ACP connection keeps identity while owner launch overrides persist', async () => {
  assert.equal(parseAgentProviderDeclaration(declaration, { packageRoot }).ok, true);
  const resolved = await resolveAgentClientLibrary({
    declaration,
    admission,
    packageRoot,
    configuration: {
      readConfig: async () =>
        JSON.stringify({ command: process.execPath, startupArgs: ['--fixture'], permissionPolicy: 'auto_allow' }),
    },
  });
  assert.equal(resolved[0].id, declaration.id);
  assert.equal(resolved[0].acp.command, process.execPath);
  assert.equal(resolved[0].acp.permissionPolicy, 'auto_allow');
  for (const invalid of [
    { id: 'different' },
    { transport: 'http' },
    { env: { KEY: 'SECRET' } },
    { command: './package-script.js' },
  ]) {
    assert.equal(parseAgentProviderConfiguration(JSON.stringify(invalid), declaration, { packageRoot }).ok, false);
  }
});

test('a package cannot grant itself permission approval through declaration or default configuration', async () => {
  const resolve = (decl, fieldDefault = '{}') =>
    resolveAgentClientLibrary({
      declaration: decl,
      packageRoot,
      admission: {
        ...admission,
        packageRecord: { manifest: { configuration: [{ key: 'connection', kind: 'string', default: fieldDefault }] } },
      },
      configuration: { readConfig: async () => undefined },
    });
  await assert.rejects(
    resolve({ ...declaration, acp: { ...declaration.acp, permissionPolicy: 'auto_allow' } }),
    /owner/,
  );
  await assert.rejects(resolve(declaration, '{"permissionPolicy":"auto_allow"}'), /owner/);
  const { configurationKey: _unused, ...staticDeclaration } = declaration;
  const { permissionPolicy: _unusedPolicy, ...acp } = declaration.acp;
  assert.equal((await resolve({ ...staticDeclaration, acp }))[0].acp.permissionPolicy, undefined);
});

test('permission changes cannot reuse a pool selected under the previous policy', () => {
  const base = { command: 'codeagent', args: ['--acp'], cwd: packageRoot, maxLiveProcesses: 1, idleTtlMs: 1 };
  assert.notEqual(
    createAcpPoolSpawnSignature({ ...base, permissionPolicy: 'deny' }),
    createAcpPoolSpawnSignature({ ...base, permissionPolicy: 'auto_allow' }),
  );
});

test(
  'a fixed client retains root-only recovery without waiving command or permission changes',
  {
    skip: process.platform !== 'win32',
  },
  async (t) => {
    const keys = ['CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE', 'CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE'];
    const previous = keys.map((key) => process.env[key]);
    t.after(() =>
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      }),
    );
    process.env[keys[0]] = 'trusted-host';
    process.env[keys[1]] = 'warn-bootstrap-root';
    const inspected = [];
    const f = await rootRecoveryFixture({
      declaration: { ...declaration, configurationKey: 'clients' },
      inspect: (root) => {
        inspected.push(root);
        return { ok: true, root, trustMode: 'trusted-host' };
      },
    });
    t.after(() => rm(f.projectRoot, { recursive: true, force: true }));
    const old = { bootstrapRoot: 'D:/OldACP', permissionPolicy: 'deny' };
    writePluginConfig(f.projectRoot, 'test.acp-library', [{ name: 'clients', value: JSON.stringify(old) }]);
    const save = (value) => f.save({ ...f.request(), updates: [{ key: 'clients', value: JSON.stringify(value) }] });
    for (const override of [
      { command: 'other-agent' },
      { permissionPolicy: 'auto_allow' },
      { bootstrapRoot: 'd:\\OLDACP\\' },
    ]) {
      await assert.rejects(save({ ...old, bootstrapRoot: 'D:/NewACP', ...override }));
      assert.equal(f.read().clients, JSON.stringify(old));
    }
    await save({ ...old, bootstrapRoot: 'D:/NewACP' });
    assert.deepEqual(JSON.parse(f.read().clients), { ...old, bootstrapRoot: 'D:/NewACP' });
    assert.equal(f.read().other, 'preserve');
    assert.ok(inspected.includes('D:/NewACP'));
  },
);

test('fixed and directory clients retain the same unspecified or explicit permission policy', async () => {
  for (const policy of [undefined, 'deny', 'auto_allow']) {
    const acp = { command: 'codeagent', startupArgs: ['--acp'], ...(policy ? { permissionPolicy: policy } : {}) };
    const run = (decl, value) =>
      resolveAgentClientLibrary({
        declaration: decl,
        admission,
        packageRoot,
        configuration: { readConfig: async () => value },
      });
    const fixed = await run({ ...declaration, acp }, JSON.stringify(acp));
    const library = await run(
      { configurationKey: 'connection' },
      JSON.stringify([{ id: 'codeagent', name: 'CodeAgent', ...acp }]),
    );
    assert.deepEqual(fixed[0].acp, library[0].acp);
    assert.equal(fixed[0].acp.permissionPolicy, policy);
  }
});
