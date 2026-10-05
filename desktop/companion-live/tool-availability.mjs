import { setTimeout as wait } from 'node:timers/promises';

export async function verifyMemoryTools(rpc, threadId, enabled, signal) {
  signal?.throwIfAborted();
  if (!enabled) return { type: 'tools-ready', state: 'disabled', tools: [] };
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await rpc.request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly' });
    signal?.throwIfAborted();
    const server = result?.data?.find((entry) => entry.name === 'cat_cafe_memory');
    const tools = Object.values(server?.tools || {}).map((tool) => tool.name);
    if (server?.runtimeStatus === 'connected' && tools.includes('cat_cafe_read_file_slice'))
      return { type: 'tools-ready', state: 'connected', tools };
    if (
      server?.toolsError ||
      ['failed', 'disabled', 'authenticationRequired', 'cancelled'].includes(server?.runtimeStatus)
    )
      throw new Error('资料工具未能加载，请结束后重新连接');
    if (attempt < 9) await wait(500, undefined, { signal });
  }
  throw new Error('资料工具加载超时，请结束后重新连接');
}
