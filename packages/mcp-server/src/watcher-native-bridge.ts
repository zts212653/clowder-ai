import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCollabToolset, registerMemoryToolset } from './server-toolsets.js';
import { type InvocationCredentialValues, withInvocationCredentials } from './tools/invocation-auth.js';

/** Same registered MCP handlers and schemas, without inheriting the provider's unrelated MCP/resource tools. */
export async function createWatcherNativeBridge(input: {
  credentials: InvocationCredentialValues;
  allowedToolNames: readonly string[];
  admit(callId: string, toolName: string): Promise<'accepted' | 'replayed' | 'exhausted'>;
}) {
  const server = new McpServer({ name: 'cat-cafe-watcher', version: '1' });
  const env = { watcher: true, allowedToolNames: input.allowedToolNames, hasAgentKey: false };
  registerCollabToolset(server, env);
  registerMemoryToolset(server, env);
  const client = new Client({ name: 'watcher-native-host', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await withInvocationCredentials(input.credentials, () => client.listTools());
  return {
    tools,
    async call(toolName: string, args: unknown, callId: string, signal?: AbortSignal) {
      const admitted = await input.admit(callId, toolName);
      if (admitted !== 'accepted')
        throw new Error(
          admitted === 'exhausted'
            ? '本轮六次工具预算已用完，请直接提交最终 checkpoint'
            : '同一次工具调用已处理，请核对原回执',
        );
      if (!input.allowedToolNames.includes(toolName)) throw new Error('Watcher tool not allowed');
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
      return withInvocationCredentials(
        { ...input.credentials, watcherAdmission: { callId, toolName }, ...(signal ? { requestSignal: signal } : {}) },
        () => client.callTool({ name: toolName, arguments: args as Record<string, unknown> }, undefined, { signal }),
      );
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
