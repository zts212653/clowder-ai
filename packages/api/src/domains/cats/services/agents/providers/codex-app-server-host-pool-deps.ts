import type { AgentCarrierSession } from '../../types.js';
import {
  type CodexAppServerHostLaunch,
  type CodexAppServerHostProcess,
  connectCodexAppServerHost,
  createCodexSocketDirectory,
  removeCodexSocketDirectory,
  spawnCodexAppServerHost,
} from './CodexUnixWebSocketSession.js';

export interface CodexAppServerHostPoolConfig {
  idleTtlMs: number;
  maxWarmHosts: number;
  /** Pool-side fallback after an invocation aborts without releasing its lease. */
  abortGraceMs?: number;
}

export interface CodexAppServerHostPoolDeps {
  createSocketDirectory(): string;
  removeSocketDirectory(path: string): Promise<void>;
  spawnHost(launch: CodexAppServerHostLaunch): Promise<CodexAppServerHostProcess>;
  connectHost(host: CodexAppServerHostProcess): Promise<AgentCarrierSession>;
}

export const DEFAULT_CODEX_APP_SERVER_HOST_POOL_DEPS: CodexAppServerHostPoolDeps = {
  createSocketDirectory: createCodexSocketDirectory,
  removeSocketDirectory: removeCodexSocketDirectory,
  spawnHost: spawnCodexAppServerHost,
  connectHost: connectCodexAppServerHost,
};
