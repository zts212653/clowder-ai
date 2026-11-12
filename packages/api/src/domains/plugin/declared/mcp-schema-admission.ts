import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { z } from 'zod';
import type { SharedMcpFactory } from './shared-mcp-factory.js';

/** Read definitions at the existing activation boundary, without a business-action client. */
export async function inspectPluginMcpSchema(factory: SharedMcpFactory) {
  const server = factory({
    invoke: async () => {
      throw new Error('Plugin MCP definition inspection cannot execute actions');
    },
  });
  const client = new Client({ name: 'clowder-plugin-schema-admission', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const signal = AbortSignal.timeout(20_000);
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport, { signal, timeout: 20_000 });
    const validator = new AjvJsonSchemaValidator();
    let cursor: string | undefined;
    do {
      const rawPage = await client.request(
        { method: 'tools/list', ...(cursor ? { params: { cursor } } : {}) },
        z.unknown(),
        { signal, timeout: 20_000 },
      );
      const parsed = ListToolsResultSchema.safeParse(rawPage);
      if (!parsed.success) return 'tool_schema_invalid' as const;
      const page = parsed.data;
      const invalid = page.tools.some((tool) => {
        try {
          validator.getValidator(tool.inputSchema);
          if (tool.outputSchema) validator.getValidator(tool.outputSchema);
          return false;
        } catch {
          return true;
        }
      });
      if (invalid) return 'tool_schema_invalid' as const;
      cursor = page.nextCursor;
    } while (cursor);
    return undefined;
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}
