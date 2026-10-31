/** Host-owned structural seam. The installed package carries its own compatible definition. */
import type { Readable } from 'node:stream';
import type {
  CollectiveArtifactConstraint,
  CollectiveArtifactCustodyTransfer,
  CollectiveArtifactMediaOperation,
  CollectiveArtifactPublication,
  CollectiveArtifactPublicationOperation,
  CollectiveArtifactPublicationRecovery,
  CollectiveArtifactRelayOperation,
  CollectiveCustodyPage,
  CollectiveCustodyPrepared,
  CollectiveCustodyReady,
  CollectiveMediaDescriptor,
} from '@cat-cafe/shared';

export type CollectiveArtifactOwnerResult =
  | { status: 'ok'; ownerDecisionRef: string; value: Record<string, unknown> }
  | {
      status: 'error';
      error: {
        code:
          | 'access_denied'
          | 'conflict'
          | 'owner_unavailable'
          | 'invalid_request'
          | 'unsupported_operation'
          | 'unknown';
      };
    };

/** Only the owner receives this capability; it contains no endpoint credential or Human bearer. */
export interface CollectiveArtifactOwnerPort {
  readonly attachments?: import('./message-attachment-port.js').CollectiveMessageAttachmentOwnerPort;
  readonly media?: CollectiveArtifactMediaReadPort;
  readonly custody?: CollectiveArtifactCustodyTransferPort;
  publish?(
    operation: CollectiveArtifactPublicationOperation,
    authority: { reauthorize(): Promise<CollectiveArtifactPublication> },
  ): Promise<CollectiveArtifactOwnerResult>;
  recoverPublication?(
    publication: CollectiveArtifactPublication,
  ): Promise<CollectiveArtifactPublicationRecovery['outcome']>;
  execute(
    operation: CollectiveArtifactRelayOperation,
    authority: {
      reauthorize(): Promise<CollectiveArtifactConstraint>;
    },
  ): Promise<CollectiveArtifactOwnerResult>;
}

export type CollectiveCustodyOwnerOperation = 'prepareSource' | 'readPage' | 'stageTarget' | 'attestReady' | 'finalize';
/** Fresh endpoint authority returns canonical metadata only; it never exposes credentials to the owner. */
export interface CollectiveCustodyOwnerAuthority {
  authorize(operation: CollectiveCustodyOwnerOperation): Promise<CollectiveArtifactCustodyTransfer>;
}
/** The single Connector seam owns the complete content/review/modification transfer unit. */
export interface CollectiveArtifactCustodyTransferPort {
  prepareSource(
    transfer: CollectiveArtifactCustodyTransfer,
    authority: CollectiveCustodyOwnerAuthority,
  ): Promise<CollectiveCustodyPrepared>;
  readPage(
    transfer: CollectiveArtifactCustodyTransfer,
    index: number,
    authority: CollectiveCustodyOwnerAuthority,
  ): Promise<CollectiveCustodyPage>;
  stageTarget(
    transfer: CollectiveArtifactCustodyTransfer,
    page: CollectiveCustodyPage,
    authority: CollectiveCustodyOwnerAuthority,
  ): Promise<void>;
  attestReady(
    transfer: CollectiveArtifactCustodyTransfer,
    authority: CollectiveCustodyOwnerAuthority,
  ): Promise<CollectiveCustodyReady>;
  finalize(transfer: CollectiveArtifactCustodyTransfer, authority: CollectiveCustodyOwnerAuthority): Promise<void>;
}
export type CollectiveArtifactMediaResult =
  | Extract<CollectiveArtifactOwnerResult, { status: 'error' }>
  | { status: 'ok'; descriptor: CollectiveMediaDescriptor; body: Readable };
/** No bytes cross a JSON owner operation, Channel event, outbox, custody stage or persistent Connector state. */
export interface CollectiveArtifactMediaReadPort {
  /** Available on the installed module proxy; requires an authenticated declared owner HTTP request. */
  listRetained?(
    input: { readonly after?: string },
    authority: CollectiveRetainedMediaAuthority,
  ): Promise<import('@cat-cafe/shared').CollectiveRetainedMediaPage>;
  prepareShare?(
    input: CollectiveRetainedMediaShareInput,
    authority: CollectiveRetainedMediaAuthority,
  ): Promise<CollectiveRetainedMediaReceipt>;
  read(
    operation: CollectiveArtifactMediaOperation,
    authority: { reauthorize(): Promise<CollectiveArtifactConstraint> },
    signal: AbortSignal,
  ): Promise<CollectiveArtifactMediaResult>;
}

/** Remote connection authority only; the Host supplies the local authenticated principal. */
export interface CollectiveRetainedMediaConstraint {
  readonly serviceInstanceId: string;
  readonly collectiveId: string;
  readonly connectionId: string;
  readonly authorizedHumanId: string;
}
export interface CollectiveRetainedMediaAuthority {
  reauthorize(): Promise<CollectiveRetainedMediaConstraint>;
}
export interface CollectiveRetainedMediaShareInput {
  readonly contentRef: string;
  readonly ownerRevision: number;
  readonly scope: import('@cat-cafe/shared').CollectiveMediaShareScope;
}
export interface CollectiveRetainedMediaReceipt {
  readonly contentRef: string;
  readonly ownerRevision: number;
  readonly blobDigest: string;
  readonly mediaType: 'image/png' | 'video/mp4';
  readonly ownerReceiptRef: string;
}
