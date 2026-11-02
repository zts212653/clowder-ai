/** Non-secret metadata. Official Codex remains the credential writer. */
export interface CodexAccountIdentity {
  readonly userId: string;
  readonly workspaceId: string;
  readonly email?: string;
  readonly planType?: string;
}
export type CodexLoginState =
  | 'preparing'
  | 'queued'
  | 'waiting'
  | 'review'
  | 'success'
  | 'reused'
  | 'canceled'
  | 'interrupted'
  | 'failed'
  | 'timeout'
  | 'superseded';
export interface CodexLoginAttempt {
  readonly id: string;
  readonly revision: number;
  readonly ownerBootId: string;
  readonly ownerPid: number;
  readonly ownerStartedAt: string;
  readonly state: CodexLoginState;
  readonly credentialHome: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly identity?: CodexAccountIdentity;
  readonly duplicateAccountRef?: string;
  readonly error?: string;
}
export interface CodexManagedAccount {
  readonly kind: 'managed';
  readonly layoutVersion: 1;
  readonly credentialHome: string;
  readonly stateRoot: string;
  readonly sqliteHome: string;
  readonly prepared: boolean;
  readonly identity?: CodexAccountIdentity;
  readonly attempt?: CodexLoginAttempt;
}
export interface AccountQuotaObservation {
  /** Non-secret principal that produced this observation; legacy observations are unverified. */
  readonly owner?: { accountRef: string; userId: string; workspaceId: string };
  readonly observedAt: number;
  readonly status: 'ok' | 'unavailable' | 'unsupported';
  readonly source: 'codex_official_readonly';
  readonly items: ReadonlyArray<{
    label: string;
    usedPercent: number;
    percentKind?: 'used' | 'remaining';
    poolId?: string;
    resetsAt?: string;
    resetsText?: string;
  }>;
  readonly error?: string;
  /** Classification of this attempt; never changes the account's sign-in state. */
  readonly failure?: {
    readonly kind: 'renewal_required' | 'signin_required' | 'service_unreachable';
    readonly officialDetail?: string;
  };
  /** SHA-256 of the queried access token; contains no reusable credential. */
  readonly credentialVersion?: string;
  /** Read-only view projection: current credential differs from the failed attempt. */
  readonly renewedCredentialVersion?: string;
  /** Previous successful reading from the same principal, retained on failed refresh. */
  readonly lastSuccess?: Pick<AccountQuotaObservation, 'observedAt' | 'items'>;
}
export function accountQuotaOwnerMatches(
  observation: AccountQuotaObservation | undefined,
  accountRef: string,
  identity: CodexAccountIdentity | undefined,
): boolean {
  return (
    !!identity &&
    observation?.owner?.accountRef === accountRef &&
    observation.owner.userId === identity.userId &&
    observation.owner.workspaceId === identity.workspaceId
  );
}
export interface ExecutionAccountSnapshot {
  readonly accountRef: string;
  readonly displayName: string;
  readonly authType: 'oauth' | 'api_key';
  readonly accountRevision: string;
  readonly identity?: CodexAccountIdentity;
}
