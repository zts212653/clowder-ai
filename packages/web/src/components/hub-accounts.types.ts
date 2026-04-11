export type ProfileMode = 'subscription' | 'api_key';
export type ProfileAuthType = 'oauth' | 'api_key';
export type ProfileKind = 'builtin' | 'api_key';
export type BuiltinAccountClient = 'anthropic' | 'openai' | 'google' | 'kimi' | 'dare' | 'opencode';

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
