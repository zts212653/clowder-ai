import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { guardMcpConfig } from '../src/secret-mcp-config.js';

for (const relative of [false, true])
  test(`relay retains upstream-only credential locations (${relative ? 'relative' : 'absolute'})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'secret-mcp-source-context-'));
    const effects = join(root, 'effects.json');
    const preloadReceipt = join(root, 'preload.jsonl');
    const script = join(root, 'server.mjs');
    const locations: Array<[string, string, string]> = [
      ['GOOGLE_APPLICATION_CREDENTIALS', 'service-identity.json', 'service-identity.json'],
      ['CODEX_CREDENTIALS_PATH', 'codex-private.json', 'codex-private.json'],
      ['CLAUDE_CREDENTIALS_PATH', 'claude-private.json', 'claude-private.json'],
      ['CODEX_HOME', 'codex', 'codex/auth.json'],
      ['CLAUDE_CONFIG_DIR', 'claude', 'claude/settings.json'],
      ['GEMINI_HOME', 'gemini', 'gemini/config/mcp_config.json'],
      ['GH_CONFIG_DIR', 'gh', 'gh/hosts.yml'],
      ['XDG_CONFIG_HOME', 'xdg', 'xdg/gh/hosts.yml'],
      ['KIMI_CODE_HOME', 'kimi', 'kimi/credentials/provider.json'],
      ['DSH_HOME', 'dsh', 'dsh/.credentials.yaml'],
      ['CAT_CAFE_MCP_CREDS_DIR', 'mcp-vault', 'mcp-vault/provider.json'],
      ['HOME', 'provider-home', 'provider-home/.claude/settings.json'],
    ];
    const environment: Record<string, string> = {};
    for (const [key, value, filename] of locations) {
      environment[key] = relative && key !== 'HOME' ? value : join(root, value);
      await mkdir(dirname(join(root, filename)), { recursive: true });
      await writeFile(join(root, filename), 'opaque configured credential');
    }
    const hostCredential = join(root, 'host-identity.json');
    await writeFile(hostCredential, 'opaque host credential');
    await writeFile(join(root, 'notes.txt'), 'ordinary notes');
    await mkdir(join(root, 'nested'));
    await symlink(join(root, locations[0][2]), join(root, 'identity-alias.json'));
    const preload = join(root, 'preload.mjs');
    await writeFile(
      preload,
      `import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(preloadReceipt)},JSON.stringify({callback:Boolean(process.env.CAT_CAFE_CALLBACK_TOKEN)})+'\\n');`,
    );
    environment.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
    await writeFile(
      script,
      `
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {McpServer} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'))};
import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
import {z} from ${JSON.stringify(import.meta.resolve('zod'))};
for (const [key,value] of Object.entries(${JSON.stringify(environment)})) assert.equal(process.env[key],value);
assert.equal(process.env.CAT_CAFE_CALLBACK_TOKEN,undefined);
const server=new McpServer({name:'credential-context-fixture',version:'1'});
for(const name of ['read_file','read_multiple_files','browser_upload','run_command']) server.registerTool(name,{inputSchema:{path:z.string().optional(),paths:z.array(z.string()).optional(),command:z.string().optional()}},async args=>{
  const path=args.path??args.paths?.[0]??'service-identity.json';
  const body=readFileSync(path,'utf8');
  writeFileSync(${JSON.stringify(effects)},JSON.stringify({path,body}));
  return {content:[{type:'text',text:body}]};
});
await server.connect(new StdioServerTransport());`,
    );
    const config = guardMcpConfig(
      { command: process.execPath, args: [script], cwd: root, env: environment },
      { CAT_CAFE_INVOCATION_ID: 'fixture-context', CAT_CAFE_CALLBACK_TOKEN: ['fixture', 'context'].join('-') },
    );
    assert.equal((config.env as Record<string, string>).NODE_OPTIONS, undefined);
    const client = new Client({ name: 'credential-context-consumer', version: '1' });
    const transport = new StdioClientTransport({
      command: String(config.command),
      args: config.args as string[],
      cwd: root,
      env: {
        HOME: root,
        GOOGLE_APPLICATION_CREDENTIALS: 'host-identity.json',
        ...(config.env as Record<string, string>),
      },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', () => {});
    try {
      await client.connect(transport);
      for (const [key, , filename] of locations) {
        for (const name of ['read_file', 'browser_upload']) {
          const result = await client.callTool({
            name,
            arguments: { path: relative ? filename : join(root, filename) },
          });
          assert.equal(result.isError, true, `${key} must remain protected for ${name}`);
          await assert.rejects(readFile(effects), 'blocked calls must not execute upstream');
        }
      }
      for (const args of [
        { name: 'read_file', arguments: { path: hostCredential } },
        { name: 'read_multiple_files', arguments: { paths: ['identity-alias.json'] } },
        { name: 'run_command', arguments: { command: 'cd nested && cat ../service-identity.json' } },
        { name: 'run_command', arguments: { command: 'cd nested && cat ../host-identity.json' } },
        { name: 'run_command', arguments: { command: 'set -- service-identity.json; cat "$1"' } },
        { name: 'run_command', arguments: { command: 'set -- service-identity.json; set -- notes.txt | cat "$1"' } },
        {
          name: 'run_command',
          arguments: { command: 'set -- service-identity.json; set -- notes.txt |& cat; cat "$1"' },
        },
        { name: 'run_command', arguments: { command: 'set -- ../service-identity.json; cd nested && cat "$1"' } },
      ]) {
        assert.equal((await client.callTool(args)).isError, true, JSON.stringify(args));
        await assert.rejects(readFile(effects));
      }
      for (const name of ['read_file', 'browser_upload']) {
        assert.notEqual((await client.callTool({ name, arguments: { path: 'notes.txt' } })).isError, true);
        assert.equal(JSON.parse(await readFile(effects, 'utf8')).body, 'ordinary notes');
      }
      assert.notEqual(
        (
          await client.callTool({
            name: 'run_command',
            arguments: { command: 'cd nested && cat ../notes.txt', path: 'notes.txt' },
          })
        ).isError,
        true,
      );
      const observations = (await readFile(preloadReceipt, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        observations,
        [{ callback: false }],
        'upstream preload never runs with proxy callback authority',
      );
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  });
