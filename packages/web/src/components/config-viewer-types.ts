export interface CoCreatorConfig {
  name: string;
  aliases: string[];
  mentionPatterns: string[];
  avatar?: string;
  color?: {
    primary: string;
    secondary: string;
  };
}

export interface CatConfig {
  displayName: string;
  clientId: string;
  model: string;
  mcpSupport: boolean;
}

/** Prompt-assembly budget derived from resolved context capacity (#1208). */
export interface PromptAssemblyBudget {
  maxPromptTokens: number;
  maxHistoryContextTokens: number;
  maxMessages: number;
  maxContentLengthPerMsg: number;
}

/**
 * Resolved capacity + derived prompt-assembly budget per cat (#1208 P1-2).
 * Replaces the old 4-field-only shape: includes source/confidence/actionable
 * so Hub can distinguish resolved from unresolved capacity.
 */
export interface CatCapacityBudget {
  inputCeilingTokens: number;
  source: 'exact' | 'catalog' | 'default' | 'manual' | 'unresolved';
  actionable: boolean;
  confidence: number;
  budget: PromptAssemblyBudget;
}

export interface Capabilities {
  skills: string[];
  externalMcpServers: string[];
}

export interface ConfigData {
  coCreator?: CoCreatorConfig;
  cats: Record<string, CatConfig>;
  perCatBudgets: Record<string, CatCapacityBudget>;
  cli?: {
    codexSandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
    codexApprovalPolicy: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  };
  a2a: { enabled: boolean; maxDepth: number };
  memory: { enabled: boolean; maxKeysPerThread: number };
  codexExecution?: {
    model: string;
    authMode: 'oauth' | 'api_key' | 'auto';
    passModelArg: boolean;
  };
  governance: { degradationEnabled: boolean; doneTimeoutMs: number; heartbeatIntervalMs: number };
  ui?: {
    bubbleDefaults: {
      thinking: 'expanded' | 'collapsed';
      cliOutput: 'expanded' | 'collapsed';
    };
  };
}
