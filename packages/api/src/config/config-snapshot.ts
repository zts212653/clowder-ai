import type { ContextBudget } from '@cat-cafe/shared';

export type HindsightEngine = 'codex_oauth' | 'hindsight_native';
export type CodexAuthMode = 'oauth' | 'api_key' | 'auto';

export interface ConfigSnapshot {
  owner: {
    name: string;
    aliases: string[];
    mentionPatterns: string[];
  };
  context: {
    /** @deprecated Use perCatBudgets for actual limits. This is assembleContext default. */
    maxMessages: number;
    /** @deprecated Use perCatBudgets for actual limits. */
    maxContentLength: number;
    /** @deprecated Use perCatBudgets for actual limits. This is assembleContext default, overridden per-cat at route time. */
    maxTotalChars: number;
    /** @deprecated Use perCatBudgets for actual limits. */
    maxPromptTokens: number;
    note: string;
  };
  /** Per-cat context budgets (Phase 4.0) — the actual limits used at route time */
  perCatBudgets: Record<string, ContextBudget>;
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
      provider: string;
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
  /** Hindsight long-term memory integration (Phase 5.0) */
  hindsight: {
    enabled: boolean;
    baseUrl: string;
    sharedBank: string;
    recallDefaults: {
      budget: 'low' | 'mid' | 'high';
      tagsMatch: 'all_strict' | 'any_strict' | 'all' | 'any';
      limit: number;
    };
    retainPolicy: {
      narrativeFactRequired: boolean;
      minUsefulHorizonDays: number;
    };
    reflect: {
      dispositionMode: 'off' | 'template_only';
    };
    engine: {
      reflect: HindsightEngine;
      retainExtraction: HindsightEngine;
      allowNativeFallback: boolean;
    };
    service: {
      mode: 'storage_retrieval_only';
      requireHealthcheck: boolean;
      writeTimeoutMs: number;
      recallTimeoutMs: number;
    };
    freshnessGuard: {
      failClosedEnabled: boolean;
      failClosedStatuses: Array<'fresh' | 'stale' | 'unknown'>;
      autoReimportEnabled: boolean;
      autoReimportCooldownMs: number;
      autoReimportCommand: string;
    };
  };
  codexExecution: {
    model: string;
    authMode: CodexAuthMode;
    passModelArg: boolean;
  };
}
