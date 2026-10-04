export interface CollectiveWorkActionTarget {
  readonly kind: 'collective-work';
  readonly connectionId: string;
  readonly workId: string;
  readonly workRevision: number;
  readonly channelId: string;
  readonly resultEventId: string;
  readonly resultRevision: number;
  readonly actionRef: string;
}

const requiredFields = ['connectionId', 'workId', 'workRevision', 'channelId', 'resultEventId'] as const;
const fields = [...requiredFields, 'resultRevision'] as const;

export function parseCollectiveWorkActionRef(actionRef: string): CollectiveWorkActionTarget | null {
  if (!actionRef.startsWith('/collective?')) return null;
  let url: URL;
  try {
    url = new URL(actionRef, 'https://cat-cafe.invalid');
  } catch {
    return null;
  }
  if (url.origin !== 'https://cat-cafe.invalid' || url.pathname !== '/collective' || url.hash) return null;
  if ([...url.searchParams.keys()].some((key) => !fields.includes(key as (typeof fields)[number]))) return null;
  if (
    requiredFields.some((key) => url.searchParams.getAll(key).length !== 1) ||
    url.searchParams.getAll('resultRevision').length > 1
  )
    return null;
  const connectionId = url.searchParams.get('connectionId');
  const workId = url.searchParams.get('workId');
  const revisionText = url.searchParams.get('workRevision');
  const channelId = url.searchParams.get('channelId');
  const resultEventId = url.searchParams.get('resultEventId');
  const resultRevisionText = url.searchParams.get('resultRevision');
  const workRevision = Number(revisionText);
  const resultRevision = resultRevisionText === null ? 1 : Number(resultRevisionText);
  if (
    !connectionId ||
    !/^con_[A-Za-z0-9_-]{8,}$/u.test(connectionId) ||
    !workId ||
    !/^work_[A-Za-z0-9_-]{8,}$/u.test(workId) ||
    !revisionText ||
    !Number.isSafeInteger(workRevision) ||
    workRevision <= 0 ||
    String(workRevision) !== revisionText ||
    !channelId ||
    channelId.trim() !== channelId ||
    channelId.length > 160 ||
    !resultEventId ||
    !/^evt_[A-Za-z0-9_-]{8,}$/u.test(resultEventId) ||
    !Number.isSafeInteger(resultRevision) ||
    resultRevision <= 0 ||
    (resultRevisionText !== null && String(resultRevision) !== resultRevisionText)
  ) {
    return null;
  }
  return {
    kind: 'collective-work',
    connectionId,
    workId,
    workRevision,
    channelId,
    resultEventId,
    resultRevision,
    actionRef,
  };
}
