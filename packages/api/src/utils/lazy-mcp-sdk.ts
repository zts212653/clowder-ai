import { createRetryableLoader } from './retryable-loader.js';

// Keep the official module identities; do not initialize unused transports.
export const loadMcpClient = createRetryableLoader(() => import('@modelcontextprotocol/sdk/client/index.js'));
export const loadMcpStdio = createRetryableLoader(() => import('@modelcontextprotocol/sdk/client/stdio.js'));
export const loadMcpHttp = createRetryableLoader(() => import('@modelcontextprotocol/sdk/client/streamableHttp.js'));
export const loadMcpTypes = createRetryableLoader(() => import('@modelcontextprotocol/sdk/types.js'));
