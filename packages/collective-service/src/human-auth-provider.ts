export type HumanAuthProviderId = 'github';

export interface ExternalHumanIdentity {
  readonly providerSubject: string;
  readonly handle: string;
  readonly displayName: string;
  readonly avatarUrl?: string;
}

export type HumanAuthProviderReadiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: 'not_configured' };

export interface HumanAuthProvider {
  readonly id: HumanAuthProviderId;
  readonly readiness: HumanAuthProviderReadiness;
  authorizationUrl(input: { readonly state: string; readonly redirectUri: string }): string;
  authenticate(input: { readonly code: string; readonly redirectUri: string }): Promise<ExternalHumanIdentity>;
}
