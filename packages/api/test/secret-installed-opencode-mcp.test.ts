import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { withOpenCodeSecretGuard } from '../src/domains/cats/services/agents/providers/opencode-secret-config.js';
import { startNativeProbeApi } from './helpers/secret-native-api.js';

for (const scenario of ['clean', 'blocked', 'unavailable'])
  test(
    `installed OpenCode merges and guards project MCP upload: ${scenario}`,
    {
      timeout: 45000,
      skip: spawnSync('opencode', ['--version'], { timeout: 5000 }).status !== 0,
    },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'secret-opencode-mcp-'));
      const server = join(root, 'browser.mjs');
      const receipt = join(root, 'sent.json');
      const file = join(root, 'attachment.txt');
      const sdk = pathToFileURL(join(import.meta.dirname, '../node_modules/@modelcontextprotocol/sdk')).href;
      const zod = pathToFileURL(join(import.meta.dirname, '../node_modules/zod/index.js')).href;
      await writeFile(file, scenario === 'blocked' ? ['ghp', '_', 'O'.repeat(36)].join('') : 'clean attachment');
      await writeFile(
        server,
        `import {McpServer} from ${JSON.stringify(`${sdk}/dist/esm/server/mcp.js`)};
import {StdioServerTransport} from ${JSON.stringify(`${sdk}/dist/esm/server/stdio.js`)};
import {z} from ${JSON.stringify(zod)};
import {readFileSync,writeFileSync} from 'node:fs';
const server=new McpServer({name:'fixture',version:'1'});
server.registerTool('browser_upload',{inputSchema:{path:z.string()}},async({path})=>{
writeFileSync(${JSON.stringify(receipt)},JSON.stringify({path,body:readFileSync(path,'utf8')}));
return {content:[{type:'text',text:'uploaded'}]};});await server.connect(new StdioServerTransport());`,
      );
      // The project entry is merged by the real client, after the host file was written.
      await writeFile(
        join(root, 'opencode.json'),
        JSON.stringify({ mcp: { external: { type: 'local', command: [process.execPath, server] } } }),
      );
      const probe = await startNativeProbeApi((tools) => {
        const tool = tools.find((entry) => /browser_upload$/.test(entry.function?.name ?? ''));
        return tool?.function ? { name: tool.function.name, args: { path: file } } : undefined;
      });
      const config = join(root, 'host-config.json');
      await writeFile(
        config,
        JSON.stringify(
          withOpenCodeSecretGuard({
            model: 'fixture/probe',
            provider: {
              fixture: {
                npm: '@ai-sdk/openai-compatible',
                options: { baseURL: probe.base, apiKey: 'fixture-local-only' },
                models: { probe: { name: 'Probe', limit: { context: 65536, output: 8192 } } },
              },
            },
          }),
        ),
      );
      if (scenario === 'unavailable') {
        const copy = join(root, 'guard-with-missing-dependencies.mjs');
        await writeFile(copy, await readFile(new URL('../../../scripts/secret-opencode-plugin.mjs', import.meta.url)));
        const settings = JSON.parse(await readFile(config, 'utf8'));
        settings.plugin = [pathToFileURL(copy).href];
        await writeFile(config, JSON.stringify(settings));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 35000);
      try {
        let errors = '';
        const child = spawn('opencode', ['run', '--auto', '--format', 'json', 'Run the supplied tool once.'], {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            USERPROFILE: root,
            XDG_CONFIG_HOME: join(root, '.config'),
            XDG_DATA_HOME: join(root, '.local/share'),
            XDG_CACHE_HOME: join(root, '.cache'),
            OPENCODE_CONFIG: config,
            CAT_CAFE_GUARD_NODE: process.execPath,
            OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
            OPENCODE_DISABLE_MODELS_FETCH: 'true',
            OPENCODE_DISABLE_SHARE: 'true',
            OPENCODE_DISABLE_AUTOUPDATE: 'true',
          },
          stdio: ['ignore', 'ignore', 'pipe'],
          signal: controller.signal,
        });
        child.stderr.on('data', (chunk) => {
          errors += chunk;
        });
        child.on('error', () => {});
        const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
        assert.equal(controller.signal.aborted, false);
        assert.equal(code, 0, errors.slice(-1500));
        assert.equal(probe.offered, true);
        assert.equal(existsSync(receipt), scenario === 'clean');
        if (scenario === 'unavailable')
          assert.match(probe.requests.slice(1).join('\n'), /secret_native_guard_unavailable/);
        if (scenario === 'clean') {
          const sent = JSON.parse(await readFile(receipt, 'utf8'));
          assert.equal(sent.body, 'clean attachment');
          assert.notEqual(sent.path, file);
          assert.equal(existsSync(sent.path), false, 'the completed upload lease was released');
        }
      } finally {
        clearTimeout(timer);
        controller.abort();
        await probe.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
