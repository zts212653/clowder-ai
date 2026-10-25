import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveServersForCat } from '../dist/config/capabilities/capability-orchestrator.js';
import { readInvocationMcpConfig } from '../dist/config/capabilities/invoke-mcp-config.js';
import { resolveAcpMcpServers } from '../dist/domains/cats/services/agents/providers/acp/acp-mcp-resolver.js';
import { materializeSessionMcpServers } from '../dist/domains/cats/services/agents/providers/acp/acp-session-env.js';
import { resolveKimiMcpSurface } from '../dist/domains/cats/services/agents/providers/kimi-mcp-surface.js';
import { buildOpenCodeMcpSync } from '../dist/domains/cats/services/agents/providers/opencode-mcp-injection.js';
import { resolveProviderMcpConfig } from '../dist/domains/cats/services/agents/providers/provider-mcp-config.js';
import { probeMcpCapability } from '../dist/routes/mcp-probe.js';
import { resolveEnvReferences } from '../dist/utils/env-references.js';
import { secretMcpContract } from './helpers/secret-mcp-contract.js';

function root(t) {
  const p = mkdtempSync(join(tmpdir(), 'mcp-env-registration-'));
  t.after(() => rmSync(p, { recursive: true, force: true }));
  mkdirSync(join(p, '.cat-cafe'));
  return p;
}
const save = (p, entry) =>
  writeFileSync(join(p, '.cat-cafe/capabilities.json'), JSON.stringify({ version: 2, capabilities: [entry] }));

test('ordinary registered environment mappings replace stale project values without rewriting project policy', async (t) => {
  const host = root(t),
    project = root(t);
  const entry = {
    id: 'fixture-mcp',
    type: 'mcp',
    source: 'external',
    globalEnabled: true,
    enabled: true,
    mcpServer: { command: process.execPath, args: ['fixture.mjs'], env: { TOKEN: '${MCP_FIXTURE_TOKEN}' } },
  };
  save(host, entry);
  save(project, {
    ...entry,
    blockedCats: ['codex'],
    mcpServer: { ...entry.mcpServer, env: { TOKEN: 'obsolete-literal', INACTIVE: 'old' } },
  });
  const before = readFileSync(join(project, '.cat-cafe/capabilities.json'), 'utf8');
  const resolved = readInvocationMcpConfig(host, project);
  assert.deepEqual(resolved.config.capabilities[0].blockedCats, ['codex']);
  assert.deepEqual(resolved.config.capabilities[0].mcpServer.env, { TOKEN: '${MCP_FIXTURE_TOKEN}', INACTIVE: 'old' });
  assert.deepEqual(
    resolveEnvReferences(resolved.config.capabilities[0].mcpServer.env, { MCP_FIXTURE_TOKEN: 'current-value' }),
    { TOKEN: 'current-value', INACTIVE: 'old' },
  );
  assert.equal(readFileSync(join(project, '.cat-cafe/capabilities.json'), 'utf8'), before);
});

test('standard stdio probe expands arbitrary env names and embedded references before real tools/list', async (t) => {
  const home = root(t),
    file = join(home, 'server.mjs');
  const previous = process.env.MCP_FIXTURE_TOKEN;
  process.env.MCP_FIXTURE_TOKEN = 'current-value';
  t.after(() => {
    if (previous === undefined) delete process.env.MCP_FIXTURE_TOKEN;
    else process.env.MCP_FIXTURE_TOKEN = previous;
  });
  writeFileSync(
    file,
    `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;
const result=q.method==='initialize'?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{tools:[{name:process.env.CUSTOM_KEY==='prefix:current-value'?'expanded':'unexpanded',inputSchema:{type:'object'}}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});`,
  );
  const result = await probeMcpCapability(
    {
      id: 'ordinary-env',
      type: 'mcp',
      mcpServer: { command: process.execPath, args: [file], env: { CUSTOM_KEY: 'prefix:${MCP_FIXTURE_TOKEN}' } },
    },
    { projectRoot: home },
  );
  assert.equal(result.connectionStatus, 'connected');
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ['expanded'],
  );
});

test('registration references leave project access, transport overrides and literal environment settings intact', (t) => {
  const host = root(t),
    project = root(t);
  const entry = {
    id: 'fixture',
    type: 'mcp',
    source: 'external',
    globalEnabled: true,
    mcpServer: { command: 'fixture', env: { LIVE: '${FIXTURE_CURRENT}', SETTING: 'global' } },
  };
  save(host, entry);
  const local = {
    ...entry,
    blockedCats: ['codex'],
    mcpServer: { command: 'fixture', env: { LIVE: 'stale', SETTING: 'project' } },
  };
  save(project, local);
  const config = readInvocationMcpConfig(host, project).config;
  assert.equal(config.capabilities[0].mcpServer.env.SETTING, 'project');
  assert.equal(resolveServersForCat(config, 'codex', { accessScope: 'project' })[0].enabled, false);
  const overridden = {
    ...local,
    blockedCats: [],
    mcpServerOverride: { command: 'user-override', env: { LIVE: 'override' } },
  };
  save(project, overridden);
  assert.equal(
    resolveServersForCat(readInvocationMcpConfig(host, project).config, 'codex', { accessScope: 'project' })[0].command,
    'user-override',
  );
  save(project, { ...entry, id: 'project-only' });
  assert.equal(readInvocationMcpConfig(host, project).config.capabilities[0].id, 'project-only');
  assert.equal(readInvocationMcpConfig(host).accessScope, 'global');
  assert.equal(readInvocationMcpConfig(root(t), project).accessScope, 'project');
});

test('client config adapters share generic env expansion, including ACP session callback materialization', async (t) => {
  const host = root(t),
    project = root(t);
  const saved = Object.fromEntries(
    ['MCP_FIXTURE_TOKEN', 'CAT_CAFE_RUNTIME_ROOT', 'CAT_CAFE_WORKSPACE_ROOT'].map((k) => [k, process.env[k]]),
  );
  process.env.MCP_FIXTURE_TOKEN = 'current-value';
  delete process.env.CAT_CAFE_RUNTIME_ROOT;
  delete process.env.CAT_CAFE_WORKSPACE_ROOT;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const entry = {
    id: 'fixture',
    type: 'mcp',
    source: 'external',
    enabled: true,
    globalEnabled: true,
    mcpServer: { command: process.execPath, args: ['fixture.mjs'], env: { CUSTOM: 'prefix:${MCP_FIXTURE_TOKEN}' } },
  };
  save(host, entry);
  save(project, { ...entry, mcpServer: { ...entry.mcpServer, env: { CUSTOM: 'obsolete' } } });
  const mcpServerPath = join(host, 'packages/mcp-server/dist/index.js');
  const callbackEnv = { CAT_CAFE_CAT_ID: 'codex' };
  const shared = await resolveProviderMcpConfig({ workingDirectory: project, mcpServerPath, callbackEnv });
  const sharedContract = secretMcpContract(shared.fixture);
  assert.equal(sharedContract.upstream.env.CUSTOM, 'prefix:current-value');
  assert.equal(sharedContract.proxyEnv.CUSTOM, undefined);
  assert.equal(sharedContract.upstream.command, entry.mcpServer.command);
  assert.deepEqual(sharedContract.upstream.args, entry.mcpServer.args);
  const kimi = await resolveKimiMcpSurface({
    workingDirectory: project,
    mcpServerPath,
    callbackEnv,
    nativeDirectory: root(t),
  });
  const kimiContract = secretMcpContract(kimi.fixture);
  assert.equal(kimiContract.upstream.env.CUSTOM, 'prefix:current-value');
  assert.equal(kimiContract.proxyEnv.CUSTOM, undefined);
  assert.equal(kimiContract.upstream.command, entry.mcpServer.command);
  assert.deepEqual(kimiContract.upstream.args, entry.mcpServer.args);
  const openCode = buildOpenCodeMcpSync(mcpServerPath, 'codex', host, project);
  // This builder returns the upstream descriptor; the runtime config writer decorates it later.
  assert.equal(openCode.fixture.environment.CUSTOM, 'prefix:current-value');
  assert.deepEqual(openCode.fixture.command, [entry.mcpServer.command, ...entry.mcpServer.args]);
  const config = readInvocationMcpConfig(host, project).config;
  const acp = await resolveAcpMcpServers(host, ['fixture'], undefined, {
    capabilitiesConfig: config,
    configSourceRoot: project,
  });
  const acpContract = secretMcpContract(materializeSessionMcpServers(acp)[0]);
  assert.equal(acpContract.upstream.env.CUSTOM, 'prefix:current-value');
  assert.equal(acpContract.proxyEnv.CUSTOM, undefined);
  assert.equal(acpContract.upstream.command, entry.mcpServer.command);
  assert.deepEqual(acpContract.upstream.args, entry.mcpServer.args);
  const native = [
    {
      name: 'plugin-fixture',
      command: process.execPath,
      args: [],
      env: [
        { name: 'CLOWDER_PLUGIN_ACTION_TOKEN', value: '${MCP_FIXTURE_TOKEN}' },
        { name: 'CAT_CAFE_CALLBACK_TOKEN', value: 'obsolete-callback' },
        { name: 'CUSTOM', value: 'untouched' },
      ],
    },
  ];
  const result = materializeSessionMcpServers(native, {
    CAT_CAFE_CALLBACK_TOKEN: 'current-callback',
    CAT_CAFE_INVOCATION_ID: 'current-invocation',
  });
  const { proxyEnv, upstream } = secretMcpContract(result[0]);
  const environment = upstream.env;
  assert.equal(proxyEnv.CLOWDER_PLUGIN_ACTION_TOKEN, undefined);
  assert.equal(proxyEnv.CUSTOM, undefined);
  assert.equal(environment.CLOWDER_PLUGIN_ACTION_TOKEN, 'current-value');
  assert.equal(environment.CAT_CAFE_CALLBACK_TOKEN, 'current-callback');
  assert.equal(environment.CAT_CAFE_INVOCATION_ID, 'current-invocation');
  assert.equal(environment.CUSTOM, 'untouched');
  assert.equal(native[0].env[0].value, '${MCP_FIXTURE_TOKEN}');
});

test('ACP expands references once at session launch, preserving replacement values verbatim', (t) => {
  const old = process.env.MCP_FIXTURE_VALUE;
  process.env.MCP_FIXTURE_VALUE = 'literal:${NOT_A_SECOND_LOOKUP}';
  t.after(() => {
    if (old === undefined) delete process.env.MCP_FIXTURE_VALUE;
    else process.env.MCP_FIXTURE_VALUE = old;
  });
  const base = [
    { name: 'ordinary', command: process.execPath, args: [], env: [{ name: 'VALUE', value: '${MCP_FIXTURE_VALUE}' }] },
  ];
  const materialized = materializeSessionMcpServers(base);
  const { proxyEnv, upstream } = secretMcpContract(materialized[0]);
  assert.equal(upstream.command, base[0].command);
  assert.deepEqual(upstream.args, base[0].args);
  assert.equal(upstream.source, base[0].name);
  assert.equal(upstream.env.VALUE, 'literal:${NOT_A_SECOND_LOOKUP}');
  assert.equal(proxyEnv.VALUE, undefined);
  assert.equal(base[0].env[0].value, '${MCP_FIXTURE_VALUE}');
});

for (const version of [1, 2]) {
  test(`v${version} invocation reads reject non-object entries and retain the existing global fallback`, (t) => {
    const host = root(t),
      project = root(t);
    const entry = {
      id: 'valid',
      type: 'mcp',
      enabled: true,
      globalEnabled: true,
      mcpServer: { command: 'fixture', env: { LIVE: '${FIXTURE_CURRENT}' } },
    };
    save(host, entry);
    const file = join(project, '.cat-cafe/capabilities.json');
    for (const invalid of [null, 'scalar', 42, false, []]) {
      const bytes = JSON.stringify({ version, capabilities: [entry, invalid] });
      writeFileSync(file, bytes);
      const resolved = readInvocationMcpConfig(host, project);
      assert.equal(resolved.configSourceRoot, host);
      assert.equal(resolved.accessScope, 'global');
      assert.deepEqual(resolved.config.capabilities, [entry]);
      assert.equal(readFileSync(file, 'utf8'), bytes);
    }
    save(project, entry);
    writeFileSync(join(host, '.cat-cafe/capabilities.json'), JSON.stringify({ version, capabilities: [null] }));
    const projectOnly = readInvocationMcpConfig(host, project);
    assert.equal(projectOnly.accessScope, 'project');
    assert.equal(projectOnly.configSourceRoot, project);
    assert.deepEqual(projectOnly.config.capabilities, [entry]);
    assert.equal(readInvocationMcpConfig(host).config, null);
    writeFileSync(file, JSON.stringify({ version, capabilities: [null] }));
    assert.equal(readInvocationMcpConfig(host, project).config, null);
  });
}
