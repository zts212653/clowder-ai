import type { ContentActorV1 } from '../video-studio/content-owner/types.js';
import type { StoredEditorSessionState } from './editor-session-store.js';

export type EditorSessionState = StoredEditorSessionState;

export interface HostAuthenticatedPrincipalV1 {
  readonly kind: 'human' | 'cat';
  readonly subjectId: string;
}

export interface EditorProviderAuthorityV1 {
  readonly providerId: string;
  readonly installationInstanceId: string;
  readonly providerVersion: string;
  readonly packageDigest: string;
  readonly grantRevision: number;
  readonly lifecycleRevision: number;
  readonly activationState: 'enabled' | 'disabled';
  readonly runtimeState: 'healthy' | 'stopped' | 'crashed';
  readonly surfaceIntegrity: string;
  readonly executionLeaseDigest: string;
}

export interface EditorProviderAuthorityPort {
  resolve(installationInstanceId: string, providerId: string): Promise<EditorProviderAuthorityV1 | undefined>;
  run<T>(expected: PreparedEditorSessionV1, work: () => Promise<T>): Promise<T>;
}

export interface PreparedEditorSessionV1 {
  /** Public, non-secret ref safe for durable F307 descriptor topology. */
  readonly sessionRef: string;
  readonly state: EditorSessionState;
  readonly contentRef: string;
  readonly actor: ContentActorV1;
  readonly ownerRevision: number;
  readonly bindingRevision: number;
  readonly providerId: string;
  readonly installationInstanceId: string;
  readonly providerVersion: string;
  readonly packageDigest: string;
  readonly grantRevision: number;
  readonly lifecycleRevision: number;
  readonly surfaceIntegrity: string;
  readonly executionLeaseDigest?: string;
  readonly revokeReason?: string;
}

export interface EditorSessionRecordV1 extends PreparedEditorSessionV1 {
  /** Ephemeral bearer returned only by issue/activate or actor-bound resume. */
  readonly sessionToken: string;
}

export type EditorSessionErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_ACTIVE'
  | 'SESSION_CLOSED'
  | 'SESSION_REVOKED'
  | 'PROVIDER_UNAVAILABLE'
  | 'AUTHORITY_CHANGED'
  | 'PRINCIPAL_MISMATCH'
  | 'SURFACE_INTEGRITY_MISMATCH';

export class EditorSessionError extends Error {
  constructor(
    readonly code: EditorSessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EditorSessionError';
  }
}
