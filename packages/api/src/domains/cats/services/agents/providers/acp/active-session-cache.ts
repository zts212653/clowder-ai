import type { AcpMcpServer, AcpNewSessionResult } from './types.js';

export class AcpSessionBindingError extends Error {}

function signature(cwd: string, servers: AcpMcpServer[]) {
  const normalized = servers.map((server) => {
    if (
      !('command' in server) ||
      !(server.name === 'cat-cafe' || server.name.startsWith('cat-cafe-')) ||
      !server.env.some((entry) => entry.name === 'CAT_CAFE_CREDENTIAL_FILE' && entry.value)
    )
      return server;
    // These two values refresh through the same session-owned credential file.
    return {
      ...server,
      env: server.env.filter((entry) => !['CAT_CAFE_INVOCATION_ID', 'CAT_CAFE_CALLBACK_TOKEN'].includes(entry.name)),
    };
  });
  return JSON.stringify([cwd, normalized]);
}

/** resume-only agents reject reloading sessions already active in this process. */
export class ActiveSessionCache {
  private sessions = new Map<string, { signature: string; result: AcpNewSessionResult }>();
  clear() {
    this.sessions.clear();
  }
  forget(sessionId: string) {
    this.sessions.delete(sessionId);
  }
  remember(result: AcpNewSessionResult, cwd: string, servers: AcpMcpServer[]) {
    if (result.sessionId) this.sessions.set(result.sessionId, { signature: signature(cwd, servers), result });
    return result;
  }
  get(sessionId: string, cwd: string, servers: AcpMcpServer[], available: boolean) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;
    if (!available || entry.signature !== signature(cwd, servers)) {
      throw new AcpSessionBindingError(
        'ACP 活跃会话的工作目录、MCP 或运行状态已改变；请显式开启新会话。原历史已保留。',
      );
    }
    return entry.result;
  }
  update(sessionId: string, response: unknown) {
    const entry = this.sessions.get(sessionId);
    if (
      entry &&
      response &&
      typeof response === 'object' &&
      'configOptions' in response &&
      Array.isArray(response.configOptions)
    ) {
      entry.result = { ...entry.result, configOptions: response.configOptions };
    }
  }
  notify(params: unknown) {
    if (!params || typeof params !== 'object' || !('sessionId' in params) || typeof params.sessionId !== 'string')
      return;
    const update = 'update' in params ? params.update : params;
    this.update(params.sessionId, update);
  }
}
