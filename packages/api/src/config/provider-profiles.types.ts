export type ProviderProfileProtocol = 'anthropic' | 'openai' | 'google';
export type ProviderProfileProvider = string;
export type ProviderProfileMode = 'subscription' | 'api_key';
export type ProviderProfileAuthType = 'oauth' | 'api_key';
export type BuiltinAccountClient = 'anthropic' | 'openai' | 'google' | 'dare' | 'opencode';
export type ProviderProfileKind = 'builtin' | 'api_key';
export type BootstrapBindingMode = 'oauth' | 'api_key' | 'skip';

export interface BootstrapBinding {
  enabled: boolean;
  mode: BootstrapBindingMode;
  accountRef?: string;
}

export type BootstrapBindings = Partial<Record<BuiltinAccountClient, BootstrapBinding>>;

export interface ProviderProfileMeta {
  id: string;
  displayName: string;
  kind: ProviderProfileKind;
  authType: ProviderProfileAuthType;
  builtin: boolean;
  client?: BuiltinAccountClient;
  protocol?: ProviderProfileProtocol;
  baseUrl?: string;
  models?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProviderProfileView extends ProviderProfileMeta {
  /** Legacy compatibility field; mirrors the profile id. */
  provider?: string;
  /** Legacy compatibility for current web code/tests. */
  name: string;
  /** Legacy compatibility field; builtin/oauth => subscription, api_key => api_key. */
  mode: ProviderProfileMode;
  hasApiKey: boolean;
}

export interface ProviderProfilesView {
  /** F127 account model no longer has a global active account pointer. */
  activeProfileId: string | null;
  providers: ProviderProfileView[];
  bootstrapBindings: BootstrapBindings;
}

export interface CreateProviderProfileInput {
  provider?: ProviderProfileProvider;
  name?: string;
  displayName?: string;
  mode?: ProviderProfileMode;
  authType?: ProviderProfileAuthType;
  protocol?: ProviderProfileProtocol;
  baseUrl?: string;
  apiKey?: string;
  modelOverride?: string;
  models?: string[];
  setActive?: boolean;
}

export interface UpdateProviderProfileInput {
  name?: string;
  displayName?: string;
  mode?: ProviderProfileMode;
  authType?: ProviderProfileAuthType;
  protocol?: ProviderProfileProtocol;
  baseUrl?: string;
  apiKey?: string;
  modelOverride?: string | null;
  models?: string[];
}

export interface RuntimeProviderProfile {
  id: string;
  authType: ProviderProfileAuthType;
  kind: ProviderProfileKind;
  client?: BuiltinAccountClient;
  protocol?: ProviderProfileProtocol;
  baseUrl?: string;
  apiKey?: string;
  models?: string[];
}

export interface AnthropicRuntimeProfile {
  id: string;
  mode: ProviderProfileMode;
  baseUrl?: string;
  apiKey?: string;
}

export interface ProviderProfilesMetaFile {
  version: 3;
  activeProfileId: string | null;
  providers: ProviderProfileMeta[];
  bootstrapBindings: BootstrapBindings;
}

export interface ProviderProfilesSecretsFile {
  version: 3;
  profiles: Record<string, { apiKey?: string }>;
}

export interface NormalizedState<T> {
  value: T;
  dirty: boolean;
}
