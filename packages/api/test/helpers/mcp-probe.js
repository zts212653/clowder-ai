import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Exercise authentication behind the same MCP protocol used by the provider. */
export function writeMcpProbe(path, body) {
  writeFileSync(
    path,
    `import {McpServer} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'))};
import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
import {readFileSync} from 'node:fs';
const server = new McpServer({name:'auth-probe',version:'1'});
server.registerTool('probe',{inputSchema:{}},async()=>{
  const value = await (async()=>{${body}})();
  return {content:[{type:'text',text:JSON.stringify(value)}]};
});
await server.connect(new StdioServerTransport());
`,
  );
}

export async function callMcpProbe(server) {
  const client = new Client({ name: 'auth-probe-consumer', version: '1' });
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: { ...process.env, ...server.env },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport, { timeout: 10000 });
    const result = await client.callTool({ name: 'probe', arguments: {} }, undefined, { timeout: 10000 });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.equal(result.content[0]?.type, 'text');
    return JSON.parse(result.content[0].text);
  } finally {
    await client.close();
  }
}
