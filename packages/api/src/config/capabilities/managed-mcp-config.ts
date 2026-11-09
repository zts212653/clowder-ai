export {
  bindManagedMcpStdioConfig,
  isInstalledManagedMcpServer,
} from '@cat-cafe/mcp-server/dist/managed-mcp-config.js';

import { fileURLToPath } from 'node:url';
import { materializeNativeMcpHttp as materialize } from '@cat-cafe/mcp-server/dist/managed-mcp-config.js';
import { invocationPluginMcpHttpPaths } from './invocation-plugin-mcp-view.js';

/** Launch the same installed package whose realpath the callback binder verifies. */
export function resolveManagedMcpEntrypoint(entrypoint: string) {
  return fileURLToPath(import.meta.resolve(`@cat-cafe/mcp-server/dist/${entrypoint}`));
}

/** Only a verified Host activation can nominate a plugin for HTTP materialization. */
export function materializeNativeMcpHttp(
  servers: Record<string, Record<string, unknown>>,
  callback: Record<string, string>,
) {
  return materialize(servers, callback, invocationPluginMcpHttpPaths(servers));
}
