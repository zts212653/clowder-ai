import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Real MCP process bound only to the caller's disposable API and original invocation. */
export async function memoryProposalNativeClient(apiUrl, auth, dataDir) {
  const client = new Client({ name: 'm3-memory-proposal', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('../mcp-server/dist/index.js')],
    cwd: resolve('../..'),
    env: {
      PATH: process.env.PATH,
      CAT_CAFE_API_URL: apiUrl,
      CAT_CAFE_INVOCATION_ID: auth.invocationId,
      CAT_CAFE_CALLBACK_TOKEN: auth.callbackToken,
      CAT_CAFE_USER_ID: auth.userId,
      CAT_CAFE_CAT_ID: auth.catId,
      CAT_CAFE_THREAD_ID: auth.threadId,
      CAT_CAFE_DATA_DIR: join(dataDir, 'mcp-data'),
      CAT_CAFE_CALLBACK_OUTBOX_DIR: join(dataDir, 'outbox'),
      CAT_CAFE_CALLBACK_RETRY_DELAYS_MS: '0,0',
    },
    stderr: 'pipe',
  });
  transport.stderr?.resume();
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
