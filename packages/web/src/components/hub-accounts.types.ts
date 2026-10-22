import type { AccountQuotaObservation, CodexManagedAccount } from '@cat-cafe/shared';

export type ProfileMode = 'subscription' | 'api_key';
export type ProfileAuthType = 'oauth' | 'api_key';
export type ProfileKind = 'builtin' | 'api_key' | 'oauth';
export type BuiltinAccountClient = 'anthropic' | 'openai' | 'google' | 'kimi' | 'opencode' | 'acp';

export interface ProfileItem {
  id: string;
  quota?: AccountQuotaObservation;
  /** Read-only canonical default-home readiness; this does not make the default managed. */
  codexLoginStatus?: 'ready' | 'not_logged_in' | 'unreadable';
  nativeLogin?: {
    home: string;
    officialDefault: boolean;
    identity?: { email?: string; workspaceId: string; userId?: string };
  };
  claude?: { kind: 'long_lived_token' };
  claudeTokenStatus?: 'saved' | 'missing' | 'expired';
  codex?: CodexManagedAccount & { status: 'not_prepared' | 'not_logged_in' | 'ready' | 'identity_changed' };
  provider?: string;
  displayName: string;
  name: string;
  authType: ProfileAuthType;
  kind: ProfileKind;
  builtin: boolean;
  /** First-run view of a detected CLI login; no stored account record exists. */
  syntheticNative?: true;
  mode: ProfileMode;
  clientId?: BuiltinAccountClient;
  baseUrl?: string;
  models?: string[];
  modelAliases?: Record<string, string>;
  modelOverride?: string | null;
  oauthLikeClient?: string;
  /** F171: User-defined env vars injected into agent subprocess. */
  envVars?: Record<string, string>;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface AccountMember {
  id: string;
  name: string;
  searchText?: string;
  avatar?: string;
  accountRef: string;
  available: boolean;
  bindingMode?: 'follow' | 'override' | 'unresolved';
}
export interface AccountSelection {
  state: 'selected' | 'consensus' | 'mixed' | 'empty';
  accountRef?: string;
  members: AccountMember[];
}

export interface AccountsResponse {
  projectPath: string;
  providers: ProfileItem[];
  nativeDefaultsError?: string;
  unavailableAccounts?: Array<{ accountRef: string; state: 'rejected'; reason: string }>;
}

export interface ProfileTestResult {
  ok: boolean;
  mode: ProfileMode;
  status?: number;
  error?: string;
  message?: string;
}
