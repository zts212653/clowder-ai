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
  coCreator?: CoCreatorConfig;
  cats: Record<string, CatConfig>;
  perCatBudgets: Record<string, ContextBudget>;
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
