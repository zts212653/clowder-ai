import type { CodexAppServerJsonObject } from './CodexAppServerEventMapper.js';

/** The port declares the native operation it needs without importing its runtime implementation. */
export interface BoundedWatcherNativeClient {
  request(method: string, params: CodexAppServerJsonObject): Promise<unknown>;
}

/** Host checkpoint operations run at exact idle boundaries, while the native owner is still held. */
export interface BoundedWatcherRunPort {
  configureProvider(input: {
    config: CodexAppServerJsonObject;
    account: CodexAppServerJsonObject | null;
    transportEnv: Readonly<Record<string, string>>;
  }): Promise<CodexAppServerJsonObject>;
  readonly instructions: string;
  readonly config: CodexAppServerJsonObject;
  readonly outputSchema: CodexAppServerJsonObject;
  readonly tools: readonly { name: string; description?: string; inputSchema: unknown }[];
  callTool(input: CodexAppServerJsonObject): Promise<CodexAppServerJsonObject>;
  beforeTurn(input: { threadId: string; client: BoundedWatcherNativeClient }): Promise<boolean>;
  accepted(input: { threadId: string; turnId: string }): Promise<void>;
  completed(input: {
    threadId: string;
    turnId: string;
    client: BoundedWatcherNativeClient;
    usage?: unknown;
  }): Promise<void>;
}
