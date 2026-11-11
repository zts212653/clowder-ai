import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { AcpMcpServer } from '../domains/cats/services/agents/providers/acp/types.js';
import { loadMcpClient, loadMcpHttp, loadMcpStdio } from '../utils/lazy-mcp-sdk.js';

/** Same admitted servers as the member, with complete pages and original schema. */
export async function readDshToolManifest(servers: AcpMcpServer[], cwd: string) {
  const { Client } = await loadMcpClient();
  const snapshots: { name: string; tools: Tool[] }[] = [];
  // Leave room for the 60s model check and cleanup within the client's 100s request.
  const manifestDeadline = AbortSignal.timeout(30_000);
  for (const server of servers) {
    const signal = AbortSignal.any([manifestDeadline, AbortSignal.timeout(20_000)]);
    const headers =
      'headers' in server ? Object.fromEntries(server.headers.map(({ name, value }) => [name, value])) : {};
    const transport =
      'command' in server
        ? new (await loadMcpStdio()).StdioClientTransport({
            command: server.command,
            args: server.args,
            cwd,
            env: {
              ...(await loadMcpStdio()).getDefaultEnvironment(),
              ...Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
            },
            stderr: 'ignore',
          })
        : server.type === 'sse'
          ? new (await import('@modelcontextprotocol/sdk/client/sse.js')).SSEClientTransport(new URL(server.url), {
              requestInit: { headers },
            })
          : new (await loadMcpHttp()).StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } });
    const client = new Client({ name: 'clowder-member-schema-check', version: '1' }, { capabilities: {} });
    try {
      await client.connect(transport, { signal, timeout: 20_000 });
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout: 20_000 });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      snapshots.push({ name: server.name, tools });
    } finally {
      await client.close();
    }
  }
  return { servers: snapshots, hash: createHash('sha256').update(JSON.stringify(snapshots)).digest('hex') };
}

/** The model sees the original definitions; calls have no business forwarding path. */
export function dshDefinitionOnlyServers(
  manifest: Awaited<ReturnType<typeof readDshToolManifest>>,
  directory: string,
): AcpMcpServer[] {
  const script = join(directory, 'definitions.mjs');
  const packageFile = fileURLToPath(new URL('../../package.json', import.meta.url));
  writeFileSync(
    script,
    `import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const require=createRequire(${JSON.stringify(packageFile)});
const load=name=>import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/'+name)).href);
const [{Server},{StdioServerTransport},{ListToolsRequestSchema,CallToolRequestSchema}]=await Promise.all([load('server/index.js'),load('server/stdio.js'),load('types.js')]);
const tools=JSON.parse(readFileSync(process.argv[2],'utf8'));
const server=new Server({name:'clowder-definition-only',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));
server.setRequestHandler(CallToolRequestSchema,async()=>({isError:true,content:[{type:'text',text:'clowder_connection_check_tools_disabled'}]}));
await server.connect(new StdioServerTransport());
`,
    { mode: 0o600 },
  );
  return manifest.servers.map((server, index) => {
    const path = join(directory, `tools-${index}.json`);
    writeFileSync(path, JSON.stringify(server.tools), { mode: 0o600 });
    return {
      name: server.name,
      command: process.execPath,
      args: [script, path],
      env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
    };
  });
}
