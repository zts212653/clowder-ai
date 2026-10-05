import { createHash } from 'node:crypto';

/** Same Task relays share the asset scope; publisher identity never substitutes for Work authority. */
export interface CollectiveDocumentScope {
  readonly userId: string;
  readonly taskId: string;
  readonly executionRevision: number;
  readonly resultRevision: number;
}

function scopePrefix(scope: CollectiveDocumentScope) {
  if (
    !scope.userId ||
    !scope.taskId ||
    !Number.isInteger(scope.executionRevision) ||
    scope.executionRevision < 1 ||
    !Number.isInteger(scope.resultRevision) ||
    scope.resultRevision < 1
  )
    throw new TypeError('Invalid Collective document scope');
  const tuple = [scope.userId, scope.taskId, scope.executionRevision, scope.resultRevision];
  return `cwork-${createHash('sha256').update(JSON.stringify(tuple)).digest('hex').slice(0, 32)}`;
}
function contentDigest(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function collectiveDocumentFileName(scope: CollectiveDocumentScope, bytes: Uint8Array): string {
  return `${scopePrefix(scope)}-${contentDigest(bytes)}.md`;
}

export function isCollectiveDocumentFile(
  scope: CollectiveDocumentScope,
  fileName: string,
  bytes?: Uint8Array,
): boolean {
  let prefix: string;
  try {
    prefix = scopePrefix(scope);
  } catch {
    return false;
  }
  if (!new RegExp(`^${prefix}-[a-f0-9]{64}\\.md$`).test(fileName)) return false;
  return bytes === undefined || fileName === collectiveDocumentFileName(scope, bytes);
}

const publications = new Map<string, Promise<unknown>>();

/** Serialize supported Host publishers, including authorized same-Task relays, without retaining authority. */
export async function serializeCollectiveDocumentPublication<T>(
  filePath: string,
  publish: () => Promise<T>,
): Promise<T> {
  const prior = publications.get(filePath) ?? Promise.resolve();
  const next = prior.then(publish, publish);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  publications.set(filePath, tail);
  try {
    return await next;
  } finally {
    if (publications.get(filePath) === tail) publications.delete(filePath);
  }
}
