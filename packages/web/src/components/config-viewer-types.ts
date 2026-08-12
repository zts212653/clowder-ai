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

export interface CatCapacityProjection {
  windowTokens: number;
  inputCeilingTokens: number;
  source: 'reported' | 'catalog' | 'manual' | 'unresolved';
  actionable: boolean;
  provenance: string;
}

export interface Capabilities {
  skills: string[];
  externalMcpServers: string[];
}

export interface ConfigData {
  coCreator?: CoCreatorConfig;
  cats: Record<string, CatConfig>;
  perCatCapacities: Record<string, CatCapacityProjection>;
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
