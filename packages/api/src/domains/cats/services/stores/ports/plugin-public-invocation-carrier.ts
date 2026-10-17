import { isDeepStrictEqual } from 'node:util';

/** Host-authored durable scheduling coordinates, never a package-provided launch grant. */
export interface PluginPublicInvocationCarrierV1 {
  readonly version: 1;
  readonly admissionId: string;
  readonly sourceMessageId: string;
  readonly sourcePluginRevision: number;
  readonly pluginInstanceId: string;
  readonly packageDigest: string;
  readonly lifecycleRevision: number;
  readonly grantRevision: number;
  readonly contributionId: string;
  readonly actionMethods: readonly string[];
  readonly targetCatId: string;
  readonly authorityRef: string;
  readonly authorityRevision: string;
}

const fields = [
  'version',
  'admissionId',
  'sourceMessageId',
  'sourcePluginRevision',
  'pluginInstanceId',
  'packageDigest',
  'lifecycleRevision',
  'grantRevision',
  'contributionId',
  'actionMethods',
  'targetCatId',
  'authorityRef',
  'authorityRevision',
];
function coordinate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  );
}
function invalid(): never {
  throw new Error('Invalid public invocation carrier');
}

export function assertPluginPublicInvocationCarrier(value: unknown): asserts value is PluginPublicInvocationCarrierV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length || Object.keys(record).some((key) => !fields.includes(key)))
    invalid();
  if (record.version !== 1) invalid();
  for (const key of ['pluginInstanceId', 'contributionId']) {
    if (!coordinate(record[key]) || (record[key] as string).length > 256) invalid();
  }
  for (const key of [
    'admissionId',
    'sourceMessageId',
    'pluginInstanceId',
    'packageDigest',
    'contributionId',
    'targetCatId',
    'authorityRef',
    'authorityRevision',
  ]) {
    if (!coordinate(record[key])) invalid();
  }
  for (const key of ['sourcePluginRevision', 'lifecycleRevision', 'grantRevision']) {
    const revision = record[key];
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < (key === 'grantRevision' ? 0 : 1))
      invalid();
  }
  const methods = record.actionMethods;
  if (
    !Array.isArray(methods) ||
    !methods.length ||
    methods.length > 256 ||
    !methods.every((method) => coordinate(method) && method.length <= 256)
  )
    invalid();
  if (new Set(methods).size !== methods.length || !isDeepStrictEqual(methods, [...methods].sort())) invalid();
}

export function clonePluginPublicInvocationCarrier(
  value: PluginPublicInvocationCarrierV1,
): PluginPublicInvocationCarrierV1 {
  assertPluginPublicInvocationCarrier(value);
  return { ...value, actionMethods: [...value.actionMethods] };
}

export function publicInvocationCarriersMatch(
  left: PluginPublicInvocationCarrierV1 | undefined,
  right: PluginPublicInvocationCarrierV1 | undefined,
): boolean {
  return isDeepStrictEqual(left, right);
}

/** Scheduling identity must never widen the external source into an owner or A2A lane. */
export function assertPublicInvocationQueueBinding(entry: {
  pluginPublicInvocation?: PluginPublicInvocationCarrierV1;
  ownerAuthProvenance: string;
  source: string;
  messageId?: string | null;
  targetCats: readonly string[];
  allTargetCats?: readonly string[];
  mergedMessageIds?: readonly string[];
  autoExecute?: boolean;
  intent: string;
  callerCatId?: string;
  a2aTriggerMessageId?: string;
  a2aParentInvocationId?: string;
  readOnlyToolPolicy?: unknown;
  waitContinuationCarrier?: unknown;
  actionSuccessorFence?: unknown;
}): void {
  const carrier = entry.pluginPublicInvocation;
  if (carrier === undefined) return;
  assertPluginPublicInvocationCarrier(carrier);
  if (
    entry.ownerAuthProvenance !== 'unknown' ||
    entry.source !== 'connector' ||
    entry.autoExecute !== true ||
    entry.intent !== 'execute' ||
    entry.messageId !== carrier.sourceMessageId ||
    entry.targetCats.length !== 1 ||
    entry.targetCats[0] !== carrier.targetCatId ||
    (entry.allTargetCats && !isDeepStrictEqual(entry.allTargetCats, entry.targetCats)) ||
    entry.mergedMessageIds?.length ||
    entry.callerCatId ||
    entry.a2aTriggerMessageId ||
    entry.a2aParentInvocationId ||
    entry.readOnlyToolPolicy ||
    entry.waitContinuationCarrier ||
    entry.actionSuccessorFence
  )
    invalid();
}
