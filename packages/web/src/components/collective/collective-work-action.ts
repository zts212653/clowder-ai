interface CollectiveActionBase {
  readonly connectionId: string;
  readonly workId: string;
  readonly workRevision: number;
  readonly channelId: string;
  readonly actionRef: string;
}

export interface CollectiveWorkResultActionTarget extends CollectiveActionBase {
  readonly kind: 'collective-work';
  readonly resultEventId: string;
  readonly resultRevision: number;
}

export interface CollectiveAccountabilityActionTarget extends CollectiveActionBase {
  readonly kind: 'collective-accountability';
  readonly roadmapId: string;
  readonly accountabilityRequestId: string;
}

export interface CollectiveProjectActionTarget {
  readonly kind: 'collective-project';
  readonly connectionId: string;
  readonly channelId: string;
  readonly roadmapId?: string;
  readonly attention: 'triage' | 'date_suggestion' | 'overdue' | 'work_dates';
  readonly workId?: string;
  readonly workRevision?: number;
  readonly actionRef: string;
}
export type CollectiveWorkActionTarget =
  | CollectiveWorkResultActionTarget
  | CollectiveAccountabilityActionTarget
  | CollectiveProjectActionTarget;

const commonFields = ['connectionId', 'workId', 'workRevision', 'channelId'] as const;
const resultFields = [...commonFields, 'resultEventId', 'resultRevision'] as const;
const accountabilityFields = [...commonFields, 'target', 'roadmapId', 'accountabilityRequestId'] as const;

export function parseCollectiveWorkActionRef(actionRef: string): CollectiveWorkActionTarget | null {
  if (!actionRef.startsWith('/collective?')) return null;
  let url: URL;
  try {
    url = new URL(actionRef, 'https://cat-cafe.invalid');
  } catch {
    return null;
  }
  if (url.origin !== 'https://cat-cafe.invalid' || url.pathname !== '/collective' || url.hash) return null;
  if (url.searchParams.get('target') === 'project-attention') return parseProjectTarget(url.searchParams, actionRef);
  return url.searchParams.get('target') === 'accountability'
    ? parseAccountabilityTarget(url.searchParams, actionRef)
    : parseResultTarget(url.searchParams, actionRef);
}

function parseCommon(params: URLSearchParams) {
  const connectionId = params.get('connectionId');
  const workId = params.get('workId');
  const revisionText = params.get('workRevision');
  const channelId = params.get('channelId');
  const workRevision = Number(revisionText);
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
    commonFields.some((key) => params.getAll(key).length !== 1)
  ) {
    return null;
  }
  return { connectionId, workId, workRevision, channelId };
}

function onlyFields(params: URLSearchParams, allowed: readonly string[]) {
  return [...params.keys()].every((key) => allowed.includes(key));
}

function parseResultTarget(params: URLSearchParams, actionRef: string): CollectiveWorkResultActionTarget | null {
  if (!onlyFields(params, resultFields) || params.has('target')) return null;
  const common = parseCommon(params);
  const resultEventId = params.get('resultEventId');
  const resultRevisionText = params.get('resultRevision');
  const resultRevision = resultRevisionText === null ? 1 : Number(resultRevisionText);
  if (
    !common ||
    params.getAll('resultEventId').length !== 1 ||
    params.getAll('resultRevision').length > 1 ||
    !resultEventId ||
    !/^evt_[A-Za-z0-9_-]{8,}$/u.test(resultEventId) ||
    !Number.isSafeInteger(resultRevision) ||
    resultRevision <= 0 ||
    (resultRevisionText !== null && String(resultRevision) !== resultRevisionText)
  ) {
    return null;
  }
  return { kind: 'collective-work', ...common, resultEventId, resultRevision, actionRef };
}

function parseAccountabilityTarget(
  params: URLSearchParams,
  actionRef: string,
): CollectiveAccountabilityActionTarget | null {
  if (!onlyFields(params, accountabilityFields) || params.getAll('target').length !== 1) return null;
  const common = parseCommon(params);
  const roadmapId = params.get('roadmapId');
  const accountabilityRequestId = params.get('accountabilityRequestId');
  if (
    !common ||
    params.getAll('roadmapId').length !== 1 ||
    params.getAll('accountabilityRequestId').length !== 1 ||
    !roadmapId ||
    !/^roadmap_[A-Za-z0-9_-]{8,}$/u.test(roadmapId) ||
    !accountabilityRequestId ||
    !/^accountability_[A-Za-z0-9_-]{8,}$/u.test(accountabilityRequestId)
  ) {
    return null;
  }
  return { kind: 'collective-accountability', ...common, roadmapId, accountabilityRequestId, actionRef };
}

function parseProjectTarget(params: URLSearchParams, actionRef: string): CollectiveProjectActionTarget | null {
  const attention = params.get('attention');
  const fields = [
    'target',
    'connectionId',
    'channelId',
    'attention',
    ...(attention === 'work_dates' ? [] : ['roadmapId']),
  ];
  const required = attention === 'triage' ? fields : [...fields, 'workId', 'workRevision'];
  if (
    !['triage', 'date_suggestion', 'overdue', 'work_dates'].includes(attention ?? '') ||
    !onlyFields(params, required) ||
    required.some((field) => params.getAll(field).length !== 1)
  )
    return null;
  const connectionId = params.get('connectionId')!,
    channelId = params.get('channelId')!,
    roadmapId = params.get('roadmapId')!;
  if (
    !/^con_[A-Za-z0-9_-]{8,}$/.test(connectionId) ||
    (attention !== 'work_dates' && !/^roadmap_[A-Za-z0-9_-]{8,}$/.test(roadmapId)) ||
    !channelId ||
    channelId.trim() !== channelId ||
    channelId.length > 160
  )
    return null;
  if (attention === 'triage')
    return { kind: 'collective-project', connectionId, channelId, roadmapId, attention, actionRef };
  const workId = params.get('workId')!,
    text = params.get('workRevision')!,
    workRevision = Number(text);
  if (
    !/^work_[A-Za-z0-9_-]{8,}$/.test(workId) ||
    !Number.isSafeInteger(workRevision) ||
    workRevision < 1 ||
    String(workRevision) !== text
  )
    return null;
  return {
    kind: 'collective-project',
    connectionId,
    channelId,
    ...(roadmapId ? { roadmapId } : {}),
    attention: attention as 'date_suggestion' | 'overdue' | 'work_dates',
    workId,
    workRevision,
    actionRef,
  };
}
