import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareKimiMcpConfig } from '../../dist/domains/cats/services/agents/providers/kimi-mcp-config.js';

export async function kimiNativeFixture(t, { nested = true, capabilities = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kimi-native-mcp-'));
  const project = join(root, 'project');
  const cwd = nested ? join(project, 'nested') : project;
  const native = join(root, 'native');
  const config = join(root, 'host');
  const binary = join(root, 'binary');
  const dist = join(binary, 'packages/mcp-server/dist');
  for (const dir of [cwd, native, join(config, '.cat-cafe'), dist, join(project, '.git')]) {
    await mkdir(dir, { recursive: true });
  }
  const previous = {
    CAT_CAFE_CONFIG_ROOT: process.env.CAT_CAFE_CONFIG_ROOT,
    CAT_CAFE_RUNTIME_ROOT: process.env.CAT_CAFE_RUNTIME_ROOT,
  };
  process.env.CAT_CAFE_CONFIG_ROOT = config;
  process.env.CAT_CAFE_RUNTIME_ROOT = binary;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const put = async (file, value) => {
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  };
  const registry = join(config, '.cat-cafe/capabilities.json');
  await put(registry, { version: 2, capabilities });
  await writeFile(join(dist, 'collab.js'), '// native contract tests never spawn this');
  const file = join(cwd, '.kimi-code/mcp.json');
  return {
    root,
    project,
    cwd,
    native,
    config,
    binary,
    dist,
    file,
    put,
    registry,
    lease: () =>
      prepareKimiMcpConfig({
        workingDirectory: cwd,
        mcpServerPath: join(dist, 'index.js'),
        callbackEnv: { CAT_CAFE_CAT_ID: 'kimi', KIMI_CODE_HOME: native },
      }),
    surface: async () => JSON.parse(await readFile(file, 'utf8')).mcpServers,
    loadInput: { cwd, homeDir: native },
  };
}

export function managedCapability(overrides = {}) {
  return {
    id: 'cat-cafe-collab',
    type: 'mcp',
    source: 'cat-cafe',
    globalEnabled: true,
    mcpServer: { command: 'node', args: ['collab.js'] },
    ...overrides,
  };
}
