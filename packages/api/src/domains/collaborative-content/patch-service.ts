import {
  ContentOwnerConflictError,
  ContentOwnerIdempotencyError,
  type ProjectContentOwnerService,
} from '../video-studio/content-owner/service.js';
import type { ContentSettlementReceiptV1 } from '../video-studio/content-owner/types.js';
import { EditorSessionError, type EditorSessionRecordV1, type EditorSessionService } from './editor-session-service.js';
import type { PreparedEditorSessionV1 } from './editor-session-types.js';
import { SemanticOperationReuseError, type SemanticOperationStore } from './semantic-operation-store.js';

export interface ContentAnchorV1 {
  readonly paragraphId: string;
  readonly textQuote: string;
}

export type CollaborativeContentOperationV1 =
  | { readonly kind: 'direct-settlement'; readonly bytes: Uint8Array }
  | { readonly kind: 'tracked-change'; readonly target: ContentAnchorV1; readonly replacement: string }
  | { readonly kind: 'comment'; readonly target: ContentAnchorV1; readonly body: string };

export interface ContentPatchMaterializerPort {
  materialize(input: {
    readonly authority: PreparedEditorSessionV1;
    readonly attribution: { readonly author: string; readonly operationId: string; readonly timestamp: string };
    readonly bytes: Buffer;
    readonly mediaType: string;
    readonly operation: Exclude<CollaborativeContentOperationV1, { readonly kind: 'direct-settlement' }>;
  }): Promise<Uint8Array>;
}

export class SemanticMaterializationError extends Error {
  constructor(
    readonly reason: 'TARGET_MISMATCH' | 'UNSUPPORTED_TARGET' | 'INVALID_DOCX' | 'LIMIT_EXCEEDED' | 'INVALID_REQUEST',
  ) {
    super(reason);
  }
}

export type CollaborativePatchResultV1 =
  | {
      readonly status: 'applied';
      readonly operationKind: CollaborativeContentOperationV1['kind'];
      readonly receipt: ContentSettlementReceiptV1;
    }
  | { readonly status: 'conflict'; readonly actualOwnerRevision: number }
  | {
      readonly status: 'rejected';
      readonly reason:
        | 'CAT_DIRECT_REPLACEMENT_FORBIDDEN'
        | 'OPERATION_ID_REUSED'
        | SemanticMaterializationError['reason'];
    }
  | { readonly status: 'unavailable'; readonly reason: EditorSessionError['code'] };

export interface CollaborativePatchServiceOptions {
  readonly sessions: Pick<EditorSessionService, 'authorize' | 'run'>;
  readonly owner: Pick<ProjectContentOwnerService, 'load' | 'settle' | 'listOutbox'>;
  readonly materializer: ContentPatchMaterializerPort;
  readonly semanticOperations?: SemanticOperationStore;
}

type SessionAuthorizationResult =
  | EditorSessionRecordV1
  | { readonly status: 'unavailable'; readonly reason: EditorSessionError['code'] };

export class CollaborativePatchService {
  constructor(private readonly options: CollaborativePatchServiceOptions) {}

  async submit(input: {
    readonly sessionToken: string;
    readonly expectedOwnerRevision: number;
    readonly operationId: string;
    readonly operation: CollaborativeContentOperationV1;
  }): Promise<CollaborativePatchResultV1> {
    const session = await this.authorize(input.sessionToken);
    if ('status' in session) return session;

    if (session.actor.kind === 'cat' && input.operation.kind === 'direct-settlement') {
      return { status: 'rejected', reason: 'CAT_DIRECT_REPLACEMENT_FORBIDDEN' };
    }

    try {
      let bytes: Uint8Array;
      let ownerOperationId = input.operationId;
      if (input.operation.kind === 'direct-settlement') {
        bytes = input.operation.bytes;
      } else {
        if (!this.options.semanticOperations)
          throw new EditorSessionError('PROVIDER_UNAVAILABLE', 'Semantic operation store unavailable');
        const intent = await this.options.semanticOperations.prepare({
          ...input,
          contentRef: session.contentRef,
          actor: session.actor,
          operation: input.operation,
        });
        ownerOperationId = intent.operationId;
        const previous = (await this.options.owner.listOutbox(session.contentRef)).find(
          (receipt) => receipt.operationId === ownerOperationId,
        );
        if (previous) {
          if (
            previous.actor.kind !== session.actor.kind ||
            previous.actor.actorId !== session.actor.actorId ||
            previous.previousOwnerRevision !== input.expectedOwnerRevision
          ) {
            return { status: 'rejected', reason: 'OPERATION_ID_REUSED' };
          }
          const receipt = await this.options.sessions.run(input.sessionToken, async () => previous);
          return { status: 'applied', operationKind: input.operation.kind, receipt };
        }
        const current = await this.options.owner.load(session.contentRef);
        if (current.ownerRevision !== input.expectedOwnerRevision) {
          return { status: 'conflict', actualOwnerRevision: current.ownerRevision };
        }
        const { sessionToken: _bearer, ...authority } = session;
        bytes = await this.options.materializer.materialize({
          authority,
          attribution: { author: session.actor.actorId, operationId: ownerOperationId, timestamp: intent.timestamp },
          bytes: current.bytes,
          mediaType: current.mediaType,
          operation: input.operation,
        });
      }
      const receipt = await this.options.sessions.run(input.sessionToken, (currentSession) =>
        this.options.owner.settle({
          contentRef: currentSession.contentRef,
          expectedOwnerRevision: input.expectedOwnerRevision,
          bytes,
          actor: currentSession.actor,
          operationId: ownerOperationId,
        }),
      );
      return { status: 'applied', operationKind: input.operation.kind, receipt };
    } catch (error: unknown) {
      if (error instanceof SemanticMaterializationError) return { status: 'rejected', reason: error.reason };
      if (error instanceof SemanticOperationReuseError) return { status: 'rejected', reason: 'OPERATION_ID_REUSED' };
      if (error instanceof EditorSessionError) return { status: 'unavailable', reason: error.code };
      if (error instanceof ContentOwnerConflictError) {
        return { status: 'conflict', actualOwnerRevision: error.actualOwnerRevision };
      }
      if (error instanceof ContentOwnerIdempotencyError) {
        return { status: 'rejected', reason: 'OPERATION_ID_REUSED' };
      }
      throw error;
    }
  }

  private async authorize(sessionToken: string): Promise<SessionAuthorizationResult> {
    try {
      return await this.options.sessions.authorize(sessionToken);
    } catch (error: unknown) {
      if (error instanceof EditorSessionError) return { status: 'unavailable', reason: error.code };
      throw error;
    }
  }
}
