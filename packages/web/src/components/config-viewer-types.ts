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
  cats: Record<string, CatConfig>;
  perCatBudgets: Record<string, ContextBudget>;
  a2a: { enabled: boolean; maxDepth: number };
  memory: { enabled: boolean; maxKeysPerThread: number };
  codexExecution?: {
    model: string;
    authMode: 'oauth' | 'api_key' | 'auto';
    passModelArg: boolean;
  };
  governance: { degradationEnabled: boolean; doneTimeoutMs: number; heartbeatIntervalMs: number };
}
