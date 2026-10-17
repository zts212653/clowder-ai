import { isDeepStrictEqual } from 'node:util';
import { snapshotPluginProtocolData } from '../../../../plugin/carrier/plugin-protocol-data.js';
import {
  assertPluginPublicInvocationCarrier,
  type PluginPublicInvocationCarrierV1,
} from '../../stores/ports/plugin-public-invocation-carrier.js';
import type { InvocationRecord } from './InvocationRegistry.js';
import { parseToolExecutionPolicy } from './tool-execution-policy.js';

/** Host-owned identity persisted atomically with callback credentials; not an admission grant. */
export interface PublicInvocationAuthBinding {
  readonly version: 1;
  readonly entryId: string;
  readonly carrier: PluginPublicInvocationCarrierV1;
}

type Identity = Pick<
  InvocationRecord,
  | 'userId'
  | 'threadId'
  | 'catId'
  | 'ownerAuthProvenance'
  | 'managedWorkBinding'
  | 'a2aTriggerMessageId'
  | 'originTriggerMessageId'
  | 'toolExecutionPolicy'
  | 'publicInvocationBinding'
>;

function coordinate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  );
}
function refuse(): never {
  throw new Error('Invalid public invocation binding');
}

/** Validate before any storage mutation; capture all public identity fields before any await. */
export function capturePublicInvocationAuth<T extends Identity>(input: T): T {
  if (Object.hasOwn(input, 'pluginTaskBinding')) refuse();
  if (input.publicInvocationBinding === undefined) return input;
  try {
    const value = snapshotPluginProtocolData(input.publicInvocationBinding) as PublicInvocationAuthBinding;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !isDeepStrictEqual(Object.keys(value).sort(), ['carrier', 'entryId', 'version']) ||
      value.version !== 1 ||
      !coordinate(value.entryId)
    )
      refuse();
    assertPluginPublicInvocationCarrier(value.carrier);
    const policy = parseToolExecutionPolicy(JSON.stringify(snapshotPluginProtocolData(input.toolExecutionPolicy)));
    if (
      !coordinate(input.userId) ||
      !coordinate(input.threadId) ||
      input.ownerAuthProvenance !== 'unknown' ||
      input.managedWorkBinding !== undefined ||
      input.a2aTriggerMessageId !== undefined ||
      input.catId !== value.carrier.targetCatId ||
      input.originTriggerMessageId !== value.carrier.sourceMessageId ||
      !isDeepStrictEqual(policy, {
        mode: 'plugin_native',
        pluginInstanceId: value.carrier.pluginInstanceId,
        contributionId: value.carrier.contributionId,
        actionMethods: value.carrier.actionMethods,
      })
    )
      refuse();
    return { ...input, publicInvocationBinding: value, toolExecutionPolicy: snapshotPluginProtocolData(policy) } as T;
  } catch {
    return refuse();
  }
}

/** Bound records must not expose the memory backend's mutable canonical identity. */
export function publicInvocationRecordView(record: InvocationRecord): InvocationRecord {
  if (record.publicInvocationBinding === undefined) return record;
  return {
    ...record,
    clientMessageIds: new Set(record.clientMessageIds),
    ...(record.traceContext ? { traceContext: { ...record.traceContext } } : {}),
  };
}
