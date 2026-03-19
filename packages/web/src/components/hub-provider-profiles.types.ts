export type ProfileMode = 'subscription' | 'api_key';
export type ProfileAuthType = 'oauth' | 'api_key';
export type ProfileProtocol = 'anthropic' | 'openai' | 'google';

export interface ProfileItem {
  id: string;
  provider: string;
  displayName: string;
  name: string;
  authType: ProfileAuthType;
  protocol: ProfileProtocol;
  builtin: boolean;
  mode: ProfileMode;
  baseUrl?: string;
  models: string[];
  modelOverride?: string;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
  targetProfileId?: string;
  oauthLikeClient?: 'dare' | 'opencode';
}

export interface ProviderProfilesResponse {
  projectPath: string;
  activeProfileId: string | null;
  activeProfileIds?: Partial<Record<ProfileProtocol, string | null>>;
  providers: ProfileItem[];
}

export interface ProfileTestResult {
  ok: boolean;
  mode: ProfileMode;
  status?: number;
  error?: string;
  message?: string;
}
