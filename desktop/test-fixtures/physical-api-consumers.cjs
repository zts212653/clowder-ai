const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');

async function verifyProtocolProcesses({ load, fixtureRoot, runtimeRoot, projectDir, root, mcp }) {
  const { AcpClient } = await load('domains/cats/services/agents/providers/acp/AcpClient.js');
  const acp = new AcpClient({
    command: process.execPath,
    cwd: projectDir,
    inheritParentEnv: false,
    args: [path.join(fixtureRoot, 'packages/api/test/fixtures/agent-session-reference/fake-acp-agent.mjs')],
  });
  try {
    await acp.initialize();
    const session = await acp.newSession(projectDir, [mcp]);
    const events = [];
    for await (const event of acp.promptStream(session.sessionId, 'physical-resource-acceptance', { timeoutMs: 5000 }))
      events.push(event);
    assert.ok(events.some((event) => event.update?.content?.text?.includes('physical-resource-acceptance')));
  } finally {
    await acp.close();
  }
  if (!fs.existsSync(mcp.args[0])) return { acp: 'passed', mcp: 'not_built' };
  const sdk = createRequire(path.join(runtimeRoot, 'packages/mcp-server/package.json'));
  const { Client } = await import(pathToFileURL(sdk.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
  const { StdioClientTransport } = await import(
    pathToFileURL(sdk.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href
  );
  const client = new Client({ name: 'physical-resource-acceptance', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: mcp.args,
    cwd: projectDir,
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: path.join(root, 'home'),
      USERPROFILE: path.join(root, 'home'),
      CAT_CAFE_DATA_DIR: path.join(root, 'mcp-data'),
      CAT_CAFE_API_URL: 'http://127.0.0.1:1',
    },
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(
      tools.some((tool) => tool.name === 'cat_cafe_post_message'),
      JSON.stringify(tools.map((tool) => tool.name)),
    );
    return { acp: 'passed', mcp: 'passed', toolCount: tools.length };
  } finally {
    await client.close();
    await transport.close();
  }
}

module.exports = async function verifyApiConsumers({ repoRoot, projectDir, root, runtimeRoot = repoRoot }) {
  const dist = path.join(runtimeRoot, 'packages/api/dist');
  if (!fs.existsSync(path.join(dist, 'index.js'))) return { status: 'api_not_built' };
  for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) process.env[key] = path.join(root, 'home');
  Object.assign(process.env, {
    CAT_CAFE_CONFIG_ROOT: projectDir,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: path.join(root, 'global'),
    CAT_CAFE_DATA_DIR: path.join(root, 'data'),
    CAT_CAFE_RUNTIME_ROOT: runtimeRoot,
    CAT_CAFE_WORKSPACE_ROOT: projectDir,
    CAT_CAFE_SKIP_HOMEDIR_MIGRATION: '1',
    OTEL_SDK_DISABLED: 'true',
  });
  process.chdir(projectDir);
  fs.writeFileSync(path.join(projectDir, 'pnpm-workspace.yaml'), 'packages: []\n');
  const load = (relative) => import(pathToFileURL(path.join(dist, relative)).href);
  const { loadDesignGateThresholdDomain } = await load(
    'infrastructure/harness-eval/design-gate/design-gate-threshold-trigger.js',
  );
  const domain = loadDesignGateThresholdDomain(path.join(projectDir, 'docs/harness-feedback'));
  const domainYaml = fs.readFileSync(
    path.join(projectDir, 'docs/harness-feedback/eval-domains/eval-design-gate.yaml'),
    'utf8',
  );
  assert.equal(Boolean(domain), !/^enabled:\s*false/m.test(domainYaml));
  if (domain) assert.equal(domain.domainId, 'eval:design-gate');
  const { custodyRecognitionPolicyVersion } = await load('domains/growing/CustodyOpportunityRuntime.js');
  assert.match(await custodyRecognitionPolicyVersion(projectDir), /^custody-recognition-v1:[a-f0-9]{64}$/);
  const { loadCompiledGovernanceL0 } = await load('domains/cats/services/context/governance-l0.js');
  assert.ok((await loadCompiledGovernanceL0(projectDir)).content.length > 100);
  const { loadA2aBallCheck } = await load('domains/cats/services/context/prompt-template-loader.js');
  assert.ok(loadA2aBallCheck().length > 100);
  const { resolveL0CompilerScriptPath } = await load('domains/cats/services/agents/providers/l0-compiler.js');
  const compiler = resolveL0CompilerScriptPath(projectDir);
  assert.equal(
    fs.realpathSync(compiler),
    fs.realpathSync(path.join(runtimeRoot, 'scripts/compile-system-prompt-l0.mjs')),
  );
  assert.ok(fs.readFileSync(compiler).length > 100);
  const { resolveBuiltinCatCafeServer } = await load('domains/cats/services/agents/providers/acp/acp-mcp-resolver.js');
  const mcp = resolveBuiltinCatCafeServer(projectDir, 'cat-cafe-collab');
  assert.equal(mcp.args[0], path.join(runtimeRoot, 'packages/mcp-server/dist/collab.js'));
  const protocols = await verifyProtocolProcesses({ load, fixtureRoot: repoRoot, runtimeRoot, projectDir, root, mcp });
  return {
    status: 'passed',
    apiCodeRoot: dist,
    fixtureRoot: repoRoot,
    runtimeRoot,
    buildCommit: fs.existsSync(path.join(dist, '.build-commit'))
      ? fs.readFileSync(path.join(dist, '.build-commit'), 'utf8').trim()
      : null,
    consumers: ['design-gate', 'custody', 'governance', 'prompt-template', 'l0-compiler', 'acp-mcp'],
    mcpPath: mcp.args[0],
    protocols,
  };
};
