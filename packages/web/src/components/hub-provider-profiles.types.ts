export type ProfileMode = 'subscription' | 'api_key';
export type ProfileAuthType = 'oauth' | 'api_key';
export type ProfileKind = 'builtin' | 'api_key';
export type BuiltinAccountClient = 'anthropic' | 'openai' | 'google' | 'dare' | 'opencode';
export type BootstrapBindingMode = 'oauth' | 'api_key' | 'skip';

export interface BootstrapBinding {
  enabled: boolean;
  mode: BootstrapBindingMode;
  accountRef?: string;
}

export interface ProfileItem {
  id: string;
  provider?: string;
  displayName: string;
  name: string;
  authType: ProfileAuthType;
  kind: ProfileKind;
  builtin: boolean;
  mode: ProfileMode;
  client?: BuiltinAccountClient;
  protocol?: string;
  baseUrl?: string;
  models?: string[];
  modelOverride?: string | null;
  oauthLikeClient?: string;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderProfilesResponse {
  projectPath: string;
  activeProfileId: string | null;
  bootstrapBindings: Partial<Record<BuiltinAccountClient, BootstrapBinding>>;
  providers: ProfileItem[];
}

export interface ProfileTestResult {
  ok: boolean;
  mode: ProfileMode;
  status?: number;
  error?: string;
  message?: string;
}
