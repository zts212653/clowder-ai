import { createHash } from 'node:crypto';
import type { ProjectContentOwnerService } from '../../video-studio/content-owner/service.js';
import type { ContentSettlementReceiptV1, LoadedProjectContentV1 } from '../../video-studio/content-owner/types.js';
import type {
  EditorSessionRecordV1,
  EditorSessionService,
  HostAuthenticatedPrincipalV1,
} from '../editor-session-service.js';
import type { CollaborativePatchService, SemanticMaterializationError } from '../patch-service.js';

export const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const DEFAULT_EDITOR_BRIDGE_MAX_CONTENT_BYTES = 50 * 1024 * 1024;

export type EditorBridgeErrorCode = 'CONTENT_TOO_LARGE' | 'PRINCIPAL_MISMATCH' | 'UNSUPPORTED_MEDIA_TYPE';

export class EditorBridgeError extends Error {
  constructor(
    readonly code: EditorBridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EditorBridgeError';
  }
}

export interface EditorBridgeLoadedContentV1 {
  readonly contentIdentity: string;
  readonly fileName: string;
  readonly ownerRevision: number;
  readonly blobDigest: `sha256:${string}`;
  readonly mediaType: typeof DOCX_MEDIA_TYPE;
  readonly bytes: Buffer;
}

export type EditorBridgeSettlementV1 =
  | { readonly status: 'applied'; readonly receipt: ContentSettlementReceiptV1 }
  | { readonly status: 'conflict'; readonly actualOwnerRevision: number }
  | {
      readonly status: 'rejected';
      readonly reason:
        | 'CAT_DIRECT_REPLACEMENT_FORBIDDEN'
        | 'OPERATION_ID_REUSED'
        | SemanticMaterializationError['reason'];
    }
  | {
      readonly status: 'unavailable';
      readonly reason:
        | 'SESSION_NOT_FOUND'
        | 'SESSION_NOT_ACTIVE'
        | 'SESSION_CLOSED'
        | 'SESSION_REVOKED'
        | 'PROVIDER_UNAVAILABLE'
        | 'AUTHORITY_CHANGED'
        | 'PRINCIPAL_MISMATCH'
        | 'SURFACE_INTEGRITY_MISMATCH';
    };

export interface EditorBridgeServiceOptions {
  readonly sessions: Pick<EditorSessionService, 'authorize'>;
  readonly owner: Pick<ProjectContentOwnerService, 'load'>;
  readonly patches: Pick<CollaborativePatchService, 'submit'>;
  readonly maxContentBytes?: number;
}

/**
 * Host-owned bridge between a dedicated-origin editor and F138/F309 authority.
 * The renderer supplies neither contentRef nor actor identity: both are fixed
 * by the Host-issued editor session before any owner call can happen.
 */
export class EditorBridgeService {
  private readonly maxContentBytes: number;

  constructor(private readonly options: EditorBridgeServiceOptions) {
    const maxContentBytes = options.maxContentBytes ?? DEFAULT_EDITOR_BRIDGE_MAX_CONTENT_BYTES;
    if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes < 1) {
      throw new TypeError('maxContentBytes must be a positive safe integer');
    }
    this.maxContentBytes = maxContentBytes;
  }

  async load(input: {
    readonly sessionToken: string;
    readonly principal: HostAuthenticatedPrincipalV1;
  }): Promise<EditorBridgeLoadedContentV1> {
    const session = await this.authorizePrincipal(input.sessionToken, input.principal);
    const content = await this.options.owner.load(session.contentRef);
    assertAdmittedContent(content, this.maxContentBytes);

    // Recheck every mutable authority fence after filesystem I/O. A renderer
    // never receives bytes from a session revoked while its load was pending.
    await this.authorizePrincipal(input.sessionToken, input.principal);
    return {
      contentIdentity: opaqueContentIdentity(session.contentRef),
      fileName: displayFileName(session.contentRef),
      ownerRevision: content.ownerRevision,
      blobDigest: content.blobDigest,
      mediaType: DOCX_MEDIA_TYPE,
      bytes: Buffer.from(content.bytes),
    };
  }

  async settle(input: {
    readonly sessionToken: string;
    readonly principal: HostAuthenticatedPrincipalV1;
    readonly expectedOwnerRevision: number;
    readonly operationId: string;
    readonly bytes: Uint8Array;
  }): Promise<EditorBridgeSettlementV1> {
    await this.authorizePrincipal(input.sessionToken, input.principal);
    if (input.bytes.byteLength > this.maxContentBytes) {
      throw new EditorBridgeError(
        'CONTENT_TOO_LARGE',
        `DOCX payload exceeds the ${this.maxContentBytes}-byte editor bridge limit`,
      );
    }
    return this.options.patches.submit({
      sessionToken: input.sessionToken,
      expectedOwnerRevision: input.expectedOwnerRevision,
      operationId: input.operationId,
      operation: { kind: 'direct-settlement', bytes: input.bytes },
    });
  }

  private async authorizePrincipal(
    sessionToken: string,
    principal: HostAuthenticatedPrincipalV1,
  ): Promise<EditorSessionRecordV1> {
    const session = await this.options.sessions.authorize(sessionToken);
    if (session.actor.kind !== principal.kind || session.actor.actorId !== principal.subjectId) {
      throw new EditorBridgeError(
        'PRINCIPAL_MISMATCH',
        'Editor session does not belong to the authenticated principal',
      );
    }
    return session;
  }
}

function assertAdmittedContent(content: LoadedProjectContentV1, maxContentBytes: number): void {
  if (content.mediaType !== DOCX_MEDIA_TYPE) {
    throw new EditorBridgeError('UNSUPPORTED_MEDIA_TYPE', `Editor bridge does not admit ${content.mediaType}`);
  }
  if (content.bytes.byteLength > maxContentBytes) {
    throw new EditorBridgeError(
      'CONTENT_TOO_LARGE',
      `DOCX payload exceeds the ${maxContentBytes}-byte editor bridge limit`,
    );
  }
}

function opaqueContentIdentity(contentRef: string): string {
  return `content-${createHash('sha256').update(contentRef).digest('hex')}`;
}

function displayFileName(contentRef: string): string {
  const candidate = contentRef.split('/').filter(Boolean).at(-1);
  return candidate?.toLowerCase().endsWith('.docx') ? candidate : 'document.docx';
}
