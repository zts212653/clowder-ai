import type { PromptAssemblyBudget } from './context-capacity.js';

export type CodexAuthMode = 'oauth' | 'api_key' | 'auto';

export interface ConfigSnapshot {
  coCreator: {
    name: string;
    aliases: string[];
    mentionPatterns: string[];
    timeZone?: string;
    avatar?: string;
    color?: {
      primary: string;
      secondary: string;
    };
  };
  /** Per-cat prompt-assembly budgets derived from resolved context capacity (#1208). */
  perCatBudgets: Record<string, PromptAssemblyBudget>;
  cli: {
    timeoutMs: number;
    killGraceMs: number;
    codexSandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
    codexApprovalPolicy: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  };
  storage: {
    messageTTL: string;
    threadTTL: string;
    taskTTL: string;
    maxMessages: number;
    maxThreads: number;
  };
  upload: {
    maxFileSize: string;
    maxFiles: number;
  };
  server: {
    port: number;
    host: string;
    redis: 'connected' | 'memory';
  };
  cats: Record<
    string,
    {
      displayName: string;
      clientId: string;
      model: string;
      mcpSupport: boolean;
    }
  >;
  a2a: {
    enabled: boolean;
    maxDepth: number;
  };
  /** Memory store settings (F3-lite) */
  memory: {
    enabled: boolean;
    maxKeysPerThread: number;
  };
  /** Governance settings (4-D-lite) */
  governance: {
    degradationEnabled: boolean;
    doneTimeoutMs: number;
    heartbeatIntervalMs: number;
  };
  /** Deliberate mode status (4-E) */
  deliberate: {
    status: 'types_only';
  };
  codexExecution: {
    model: string;
    authMode: CodexAuthMode;
    passModelArg: boolean;
  };
  /** F102 evidence/summary feature flags (Phase G) */
  f102: {
    embedMode: string;
    abstractiveEnabled: boolean;
  };
  /** UI display preferences (bubble expand/collapse defaults) */
  ui: {
    bubbleDefaults: {
      thinking: 'expanded' | 'collapsed';
      cliOutput: 'expanded' | 'collapsed';
    };
  };
}
