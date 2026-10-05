import { type ContentModificationRequest, contentModificationRequestSchema } from '@cat-cafe/shared';

export interface ModificationDraft {
  v: 1;
  sourceVersion: string;
  body: string;
  targetCatId: string;
  threadId: string;
  intent?: Omit<ContentModificationRequest['intent'], 'body'>;
  operation?: ContentModificationRequest;
  requestId?: string;
  cancellationPending?: boolean;
  rejectionPending?: string[];
  acceptOperations: Record<string, string>;
  acceptBases?: Record<string, string>;
  previousScopes?: ModificationDraftScope[];
}
export interface ModificationDraftScope {
  sourceVersion: string;
  targetCatId: string;
  threadId: string;
  intent?: ModificationDraft['intent'];
}
export function modificationSourceVersion(source: ContentModificationRequest['source']): string {
  return source.kind === 'publication'
    ? `${source.contentRef}:${source.ownerRevision}`
    : source.kind === 'artifact-review'
      ? `${source.reviewId}:round:${source.round}`
      : `${source.reviewId}:${source.expectedSourceRevision}`;
}
export function modificationStorageKey(ownerUserId: string, source: ContentModificationRequest['source']): string {
  const object = source.kind === 'publication' ? source.contentRef : source.reviewId;
  return `cat-cafe:content-modification:${ownerUserId}:${object}`;
}
export function readModificationDraft(key: string): ModificationDraft | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const value = JSON.parse(raw) as ModificationDraft;
  if (
    value.v !== 1 ||
    typeof value.body !== 'string' ||
    typeof value.sourceVersion !== 'string' ||
    typeof value.targetCatId !== 'string' ||
    typeof value.threadId !== 'string' ||
    !value.acceptOperations ||
    typeof value.acceptOperations !== 'object' ||
    Array.isArray(value.acceptOperations)
  )
    throw new Error('draft_unavailable');
  if (value.operation) contentModificationRequestSchema.parse(value.operation);
  if (value.previousScopes !== undefined) {
    if (!Array.isArray(value.previousScopes)) throw new Error('draft_unavailable');
    for (const scope of value.previousScopes) {
      if (
        !scope ||
        typeof scope.sourceVersion !== 'string' ||
        typeof scope.targetCatId !== 'string' ||
        typeof scope.threadId !== 'string'
      )
        throw new Error('draft_unavailable');
      if (scope.intent)
        contentModificationRequestSchema.shape.intent.parse({ ...scope.intent, body: 'Retained draft scope' });
    }
  }
  return value;
}
export function saveModificationDraft(key: string, draft: ModificationDraft): void {
  localStorage.setItem(key, JSON.stringify(draft));
}
