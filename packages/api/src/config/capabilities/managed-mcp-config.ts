export {
  bindManagedMcpStdioConfig,
  isInstalledManagedMcpServer,
} from '@cat-cafe/mcp-server/dist/managed-mcp-config.js';

import { materializeNativeMcpHttp as materialize } from '@cat-cafe/mcp-server/dist/managed-mcp-config.js';
import { invocationPluginMcpHttpPaths } from './invocation-plugin-mcp-view.js';

/** Only a verified Host activation can nominate a plugin for HTTP materialization. */
export function materializeNativeMcpHttp(
  servers: Record<string, Record<string, unknown>>,
  callback: Record<string, string>,
) {
  return materialize(servers, callback, invocationPluginMcpHttpPaths(servers));
}
