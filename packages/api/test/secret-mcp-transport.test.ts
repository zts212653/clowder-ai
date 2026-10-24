import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { guardMcpConfig } from '../src/config/capabilities/secret-mcp-config.js';

test(
  'provider config executes the real guarded external MCP transport and freezes browser upload bytes',
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'secret-mcp-transport-'));
    const server = join(root, 'server.mjs');
    const receipt = join(root, 'receipt.json');
    const file = join(root, 'upload.txt');
    const credential = join(root, '.env.local');
    const readReceipt = join(root, 'read-receipt.json');
    const sdk = pathToFileURL(join(import.meta.dirname, '../node_modules/@modelcontextprotocol/sdk')).href;
    const zod = pathToFileURL(join(import.meta.dirname, '../node_modules/zod/index.js')).href;
    await writeFile(
      server,
      `import {McpServer} from ${JSON.stringify(`${sdk}/dist/esm/server/mcp.js`)};\nimport {StdioServerTransport} from ${JSON.stringify(`${sdk}/dist/esm/server/stdio.js`)};\nimport {z} from ${JSON.stringify(zod)};\nimport {readFileSync,writeFileSync} from 'node:fs';\nconst mcp=new McpServer({name:'browser-fixture',version:'1'});\nmcp.registerTool('browser_upload',{inputSchema:{path:z.string()}},async ({path})=>{writeFileSync(${JSON.stringify(receipt)},JSON.stringify({path,body:readFileSync(path,'utf8')}));return {content:[{type:'text',text:'uploaded'}]};});\nmcp.registerTool('read_multiple_files',{inputSchema:{paths:z.array(z.string())}},async ({paths})=>{writeFileSync(${JSON.stringify(readReceipt)},'read');return {content:paths.map(path=>({type:'text',text:readFileSync(path,'utf8')}))};});\nawait mcp.connect(new StdioServerTransport());`,
    );
    const config = guardMcpConfig({ command: process.execPath, args: [server], env: {} });
    const client = new Client({ name: 'provider-fixture', version: '1' });
    const transport = new StdioClientTransport({
      command: String(config.command),
      args: config.args as string[],
      env: config.env as Record<string, string>,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', () => {});
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools[0].name, 'browser_upload');
      const fake = ['ghp', '_', 'T'.repeat(36)].join('');
      await writeFile(file, fake);
      const blocked = await client.callTool({ name: 'browser_upload', arguments: { path: file } });
      assert.equal(blocked.isError, true);
      await assert.rejects(readFile(receipt));
      await writeFile(file, 'clean attachment');
      const clean = await client.callTool({ name: 'browser_upload', arguments: { path: file } });
      assert.equal(clean.isError, undefined);
      const sent = JSON.parse(await readFile(receipt, 'utf8'));
      assert.equal(sent.body, 'clean attachment');
      assert.notEqual(sent.path, file);
      await assert.rejects(readFile(sent.path));
      await writeFile(credential, 'opaque fixture credential');
      const deniedRead = await client.callTool({
        name: 'read_multiple_files',
        arguments: { paths: [file, credential] },
      });
      assert.equal(deniedRead.isError, true);
      await assert.rejects(readFile(readReceipt));
      const cleanRead = await client.callTool({ name: 'read_multiple_files', arguments: { paths: [file] } });
      assert.equal(cleanRead.isError, undefined);
      assert.equal(await readFile(readReceipt, 'utf8'), 'read');
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

for (const relative of [false, true])
  for (const operation of ['read', 'upload', 'blocked-upload'])
    test(`external MCP ${relative ? 'relative' : 'absolute'} cwd resolves ${operation} at the upstream root`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'secret-mcp-cwd-'));
      const serverRoot = join(root, 'server');
      const script = join(root, 'server.mjs');
      const receipt = join(root, 'receipt.json');
      await mkdir(serverRoot);
      const sdk = pathToFileURL(join(import.meta.dirname, '../node_modules/@modelcontextprotocol/sdk')).href;
      const zod = pathToFileURL(join(import.meta.dirname, '../node_modules/zod/index.js')).href;
      await writeFile(
        script,
        `
import {McpServer} from ${JSON.stringify(`${sdk}/dist/esm/server/mcp.js`)};
import {StdioServerTransport} from ${JSON.stringify(`${sdk}/dist/esm/server/stdio.js`)};
import {z} from ${JSON.stringify(zod)};
import {readFileSync,writeFileSync} from 'node:fs';
const server=new McpServer({name:'cwd-fixture',version:'1'});
for(const name of ['read_file','browser_upload']) server.registerTool(name,{inputSchema:{path:z.string()}},async ({path})=>{
  const text=readFileSync(path,'utf8');
  writeFileSync(${JSON.stringify(receipt)},JSON.stringify({path,text}));
  return {content:[{type:'text',text}]};
});
await server.connect(new StdioServerTransport());
`,
      );
      const fake = ['ghp', '_', 'W'.repeat(36)].join('');
      const filename = operation === 'read' ? 'notes.txt' : 'upload.txt';
      await writeFile(join(root, filename), operation === 'upload' ? fake : 'proxy-root content');
      if (operation === 'read') {
        await writeFile(join(serverRoot, '.env.local'), 'opaque fixture credential');
        await symlink(join(serverRoot, '.env.local'), join(serverRoot, filename));
      } else {
        await writeFile(join(serverRoot, filename), operation === 'upload' ? 'upstream clean content' : fake);
      }
      const config = guardMcpConfig({
        command: process.execPath,
        args: [script],
        cwd: relative ? 'server' : serverRoot,
        env: {},
      });
      const client = new Client({ name: 'cwd-fixture', version: '1' });
      const transport = new StdioClientTransport({
        command: String(config.command),
        args: config.args as string[],
        cwd: root,
        env: config.env as Record<string, string>,
        stderr: 'pipe',
      });
      transport.stderr?.on('data', () => {});
      try {
        await client.connect(transport);
        const result = await client.callTool({
          name: operation === 'read' ? 'read_file' : 'browser_upload',
          arguments: { path: filename },
        });
        if (operation === 'upload') {
          assert.equal(result.isError, undefined);
          const sent = JSON.parse(await readFile(receipt, 'utf8'));
          assert.equal(sent.text, 'upstream clean content');
          assert.notEqual(sent.path, filename);
        } else {
          assert.equal(result.isError, true);
          await assert.rejects(readFile(receipt));
        }
      } finally {
        await client.close();
        await rm(root, { recursive: true, force: true });
      }
    });
