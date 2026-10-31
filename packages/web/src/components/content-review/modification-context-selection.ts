import type { ContentModificationContextCatalogue, ContentModificationRequest } from '@cat-cafe/shared';
import { modificationStorageKey, readModificationDraft } from './modification-draft';

type Source = ContentModificationRequest['source'];
export interface ModificationContextSelection {
  v: 1;
  requestId: string | null;
  composing: boolean;
  newRequest?: boolean;
  draftAfterRequestId?: string;
  draftSourceVersion?: string;
}
export function modificationContextSelectionKey(ownerUserId: string, source: Source, taskId?: string) {
  return `${modificationStorageKey(ownerUserId, source)}:landing:${taskId ?? 'all'}`;
}
export function restoreModificationContext(
  catalogue: ContentModificationContextCatalogue,
  input: {
    ownerUserId: string;
    source: Source;
    taskId?: string;
    requestId?: string;
  },
): ModificationContextSelection & { error?: string } {
  const key = modificationContextSelectionKey(input.ownerUserId, input.source, input.taskId);
  const stored = localStorage.getItem(key);
  const saved = stored ? (JSON.parse(stored) as ModificationContextSelection) : null;
  if (
    saved &&
    (saved.v !== 1 ||
      (saved.requestId !== null && typeof saved.requestId !== 'string') ||
      typeof saved.composing !== 'boolean' ||
      (saved.newRequest !== undefined && typeof saved.newRequest !== 'boolean') ||
      (saved.draftSourceVersion !== undefined &&
        (typeof saved.draftSourceVersion !== 'string' ||
          !saved.draftSourceVersion ||
          saved.draftSourceVersion.length > 4096)) ||
      (saved.draftAfterRequestId !== undefined &&
        (typeof saved.draftAfterRequestId !== 'string' || saved.draftAfterRequestId !== saved.requestId)))
  )
    throw new Error('原上下文记录暂时无法识别，请保留浏览器存储后重试。');
  const requestId = input.requestId ?? saved?.requestId;
  if (requestId) {
    if (requestId === 'draft' || catalogue.requests.some((request) => request.record.requestId === requestId))
      return {
        v: 1,
        requestId,
        composing: !input.requestId && saved?.composing === true,
        ...(!input.requestId && saved?.newRequest ? { newRequest: true } : {}),
        ...(!input.requestId && saved?.draftAfterRequestId ? { draftAfterRequestId: saved.draftAfterRequestId } : {}),
        ...(!input.requestId && saved?.draftSourceVersion ? { draftSourceVersion: saved.draftSourceVersion } : {}),
      };
    return { v: 1, requestId: null, composing: false, error: '上次选择的修改请求当前不可用，请明确选择要继续的委托。' };
  }
  const prior = readModificationDraft(modificationStorageKey(input.ownerUserId, input.source));
  if (prior?.operation)
    return {
      v: 1,
      requestId:
        catalogue.requests.find((request) => request.record.payload.operationId === prior.operation?.operationId)
          ?.record.requestId ?? 'draft',
      composing: false,
    };
  if (prior?.body.trim() && !catalogue.contexts.length) return { v: 1, requestId: 'draft', composing: false };
  const context = input.taskId
    ? catalogue.contexts.find((context) => context.taskId === input.taskId)
    : catalogue.contexts.length === 1
      ? catalogue.contexts[0]
      : null;
  return {
    v: 1,
    requestId:
      context?.requestIds[0] ?? (catalogue.requests.length === 1 ? catalogue.requests[0]!.record.requestId : null),
    composing: false,
  };
}
export function scopeModificationCatalogue(catalogue: ContentModificationContextCatalogue, taskId?: string) {
  if (!taskId) return catalogue;
  const contexts = catalogue.contexts.filter((context) => context.taskId === taskId);
  const ids = new Set(contexts.flatMap((context) => context.requestIds));
  return {
    ...catalogue,
    contexts,
    requests: catalogue.requests.filter((request) => ids.has(request.record.requestId)),
  };
}
