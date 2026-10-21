import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { resolveInvokeCapabilityRoot } from '../src/config/capabilities/invoke-capability-root.js';
import { resolveStartupCliConfigContext } from '../src/config/capabilities/startup-cli-config.js';
import { resolveAcpMcpServers } from '../src/domains/cats/services/agents/providers/acp/acp-mcp-resolver.js';
import { resolveProviderMcpConfigResolution } from '../src/domains/cats/services/agents/providers/provider-mcp-config.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-capability-roots-'));
  const binary = join(root, 'binary');
  const config = join(root, 'instance');
  const workspace = join(config, 'workspace');
  const dist = join(binary, 'packages/mcp-server/dist');
  for (const directory of [dist, workspace, join(config, '.cat-cafe')]) await mkdir(directory, { recursive: true });
  await writeFile(join(binary, 'pnpm-workspace.yaml'), 'packages: []\n');
  for (const name of ['index', 'collab']) await writeFile(join(dist, `${name}.js`), '// not executed\n');
  const file = join(config, '.cat-cafe/capabilities.json');
  await writeFile(
    file,
    JSON.stringify({
      version: 2,
      capabilities: [
        {
          id: 'cat-cafe-collab',
          type: 'mcp',
          source: 'cat-cafe',
          globalEnabled: true,
          mcpServer: { command: 'node', args: [join(dist, 'collab.js')] },
        },
      ],
    }),
  );
  const env = { CAT_CAFE_CONFIG_ROOT: config, CAT_CAFE_RUNTIME_ROOT: binary, CAT_CAFE_WORKSPACE_ROOT: workspace };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(async () => {
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(root, { recursive: true, force: true });
  });
  return { binary, config, workspace, dist, file, env };
}

test('invoke and startup share the explicit configuration root, independent of workspace and binaries', async (t) => {
  const f = await fixture(t);
  assert.equal(await resolveInvokeCapabilityRoot(f.binary), f.config);
  assert.equal(resolveStartupCliConfigContext(f.binary, f.env).projectRoot, f.config);
});

test('native MCP admission reads the configuration root and leaves its file unchanged', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.file);
  const result = await resolveProviderMcpConfigResolution({
    callbackEnv: { CAT_CAFE_CAT_ID: 'opus' },
    workingDirectory: f.workspace,
    mcpServerPath: join(f.dist, 'index.js'),
  });
  assert.equal(result.source, 'capabilities.json');
  assert.deepEqual(result.servers['cat-cafe-collab'].args, [join(f.dist, 'collab.js')]);
  assert.ok((await readFile(f.file)).equals(before));
});

test('a declared invalid configuration root is rejected instead of falling back to workspace', async (t) => {
  const f = await fixture(t);
  process.env.CAT_CAFE_CONFIG_ROOT = join(f.config, 'missing');
  await assert.rejects(resolveInvokeCapabilityRoot(f.binary), /persistent global capabilities root/i);
});

test('ACP builtins use runtime binaries while external MCP paths remain relative to their configuration', async (t) => {
  const f = await fixture(t);
  const result = await resolveAcpMcpServers(f.config, ['cat-cafe-collab', 'external'], undefined, {
    capabilitiesConfig: {
      version: 1,
      capabilities: [
        {
          id: 'external',
          type: 'mcp',
          source: 'external',
          enabled: true,
          mcpServer: { command: 'node', args: ['./external.js'] },
        },
      ],
    },
    configSourceRoot: f.config,
  });
  assert.deepEqual(result.find((server) => server.name === 'cat-cafe-collab')?.args, [join(f.dist, 'collab.js')]);
  assert.deepEqual(result.find((server) => server.name === 'external')?.args, ['./external.js']);
});

test('empty and unreadable explicit registries do not fall back to enabled runtime tools', async (t) => {
  const f = await fixture(t);
  const input = {
    callbackEnv: { CAT_CAFE_CAT_ID: 'opus' },
    workingDirectory: f.workspace,
    mcpServerPath: join(f.dist, 'index.js'),
  };
  await writeFile(f.file, '{"version":2,"capabilities":[]}');
  assert.deepEqual((await resolveProviderMcpConfigResolution(input)).servers, {});
  assert.deepEqual(
    await resolveAcpMcpServers(f.config, [], undefined, {
      mcpSupport: true,
      capabilitiesConfig: { version: 2, capabilities: [] },
    }),
    [],
  );
  await writeFile(f.file, '{broken');
  await assert.rejects(resolveProviderMcpConfigResolution(input), /missing or unreadable/);
  assert.equal(await readFile(f.file, 'utf8'), '{broken');
});

test('an explicit same-root registry remains authoritative when missing or corrupt', async (t) => {
  const f = await fixture(t);
  process.env.CAT_CAFE_CONFIG_ROOT = f.binary;
  const file = join(f.binary, '.cat-cafe/capabilities.json');
  const invoke = () =>
    resolveProviderMcpConfigResolution({
      callbackEnv: { CAT_CAFE_CAT_ID: 'opus' },
      workingDirectory: f.workspace,
      mcpServerPath: join(f.dist, 'index.js'),
    });
  await assert.rejects(invoke(), /missing or unreadable/);
  await mkdir(join(f.binary, '.cat-cafe'));
  await writeFile(file, '{broken');
  await assert.rejects(invoke(), /missing or unreadable/);
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('ACP rejects a missing explicitly selected registry even when binary and config roots coincide', async (t) => {
  const f = await fixture(t);
  process.env.CAT_CAFE_CONFIG_ROOT = f.binary;
  await assert.rejects(resolveAcpMcpServers(f.binary, [], undefined, { mcpSupport: true }), /missing or unreadable/);
});
