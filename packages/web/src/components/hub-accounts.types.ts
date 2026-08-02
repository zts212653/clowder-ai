export type ProfileMode = 'subscription' | 'api_key';
export type ProfileAuthType = 'oauth' | 'api_key';
export type ProfileKind = 'builtin' | 'api_key';
export type BuiltinAccountClient = 'anthropic' | 'openai' | 'google' | 'kimi' | 'opencode' | 'acp';

export interface ProfileItem {
  id: string;
  provider?: string;
  displayName: string;
  name: string;
  authType: ProfileAuthType;
  kind: ProfileKind;
  builtin: boolean;
  mode: ProfileMode;
  clientId?: BuiltinAccountClient;
  baseUrl?: string;
  models?: string[];
  modelOverride?: string | null;
  oauthLikeClient?: string;
  /** F171: User-defined env vars injected into agent subprocess. */
  envVars?: Record<string, string>;
  /** F159 G2 (AC-G20): typed client family for api_key accounts — drives adapter routing. */
  clientFamily?: 'anthropic' | 'openai' | 'google' | 'kimi' | 'opencode';
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AccountsResponse {
  projectPath: string;
  providers: ProfileItem[];
}

export interface ProfileTestResult {
  ok: boolean;
  mode: ProfileMode;
  status?: number;
  error?: string;
  message?: string;
}
