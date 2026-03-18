export interface OwnerConfig {
  name: string;
  aliases: string[];
  mentionPatterns: string[];
}

export interface CatConfig {
  displayName: string;
  provider: string;
  model: string;
  mcpSupport: boolean;
}

export interface ContextBudget {
  maxPromptTokens: number;
  maxContextTokens: number;
  maxMessages: number;
  maxContentLengthPerMsg: number;
}

export interface Capabilities {
  skills: string[];
  externalMcpServers: string[];
}

export interface ConfigData {
  owner?: OwnerConfig;
  cats: Record<string, CatConfig>;
  perCatBudgets: Record<string, ContextBudget>;
  cli?: {
    codexSandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
    codexApprovalPolicy: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  };
  a2a: { enabled: boolean; maxDepth: number };
  memory: { enabled: boolean; maxKeysPerThread: number };
  hindsight: {
    enabled: boolean;
    baseUrl: string;
    sharedBank: string;
    recallDefaults?: {
      budget: 'low' | 'mid' | 'high';
      tagsMatch: 'any' | 'all' | 'any_strict' | 'all_strict';
      limit: number;
    };
    retainPolicy?: {
      narrativeFactRequired: boolean;
      minUsefulHorizonDays: number;
      anchorRequired?: boolean;
    };
    reflect?: {
      dispositionMode: 'off' | 'template_only';
    };
    engine?: {
      reflect: 'codex_oauth' | 'hindsight_native';
      retainExtraction: 'codex_oauth' | 'hindsight_native';
      allowNativeFallback: boolean;
    };
    service?: {
      mode: string;
      requireHealthcheck: boolean;
      writeTimeoutMs: number;
      recallTimeoutMs: number;
    };
  };
  codexExecution?: {
    model: string;
    authMode: 'oauth' | 'api_key' | 'auto';
    passModelArg: boolean;
  };
  governance: { degradationEnabled: boolean; doneTimeoutMs: number; heartbeatIntervalMs: number };
}
