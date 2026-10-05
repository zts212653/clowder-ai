import {
  type CollectiveHostWorkPolicyCommand,
  type CollectiveWorkGrantScope,
  type CollectiveWorkPolicy,
  type CollectiveWorkPolicyReceipt,
  type CollectiveWorkProjection,
  collectiveHostWorkPolicyCommandSchema,
} from '@cat-cafe/shared';
import type { ClientRequest } from './client-request.js';

type BrowserStore = Pick<Storage, 'getItem' | 'setItem'>;
interface Operation {
  path: string;
  body: Record<string, unknown>;
  fingerprint: string;
}

/** Only Client's existing Human request closure executes this. No session token enters the bridge. */
export async function executeHostWorkPolicyCommand(input: {
  command: unknown;
  request: ClientRequest;
  storage: BrowserStore;
}): Promise<CollectiveWorkPolicyReceipt> {
  const command = collectiveHostWorkPolicyCommandSchema.parse(input.command);
  const { serviceInstanceId, collectiveId, connectionId } = command;
  const coordinates = { serviceInstanceId, collectiveId, connectionId };
  const key = `collective-owner-command:${serviceInstanceId}:${collectiveId}:${connectionId}:${command.humanId}:${command.commandId}`;
  const fingerprint = JSON.stringify(command.action);
  const previous = input.storage.getItem(key);
  let operation: Operation;
  if (previous) {
    operation = JSON.parse(previous) as Operation;
    if (operation.fingerprint !== fingerprint) throw new Error('这项更改的内容已经变化，请重新操作。');
  } else {
    const result = await input.request<{ policy: CollectiveWorkPolicy | null }>(
      '/api/participation/work-policy/read-owner',
      { method: 'POST', body: JSON.stringify(coordinates) },
    );
    if (result.policy && result.policy.ownerHumanId !== command.humanId) throw new Error('这份授权不属于当前 Café。');
    const policy = result.policy;
    const active: CollectiveWorkGrantScope[] = (policy?.grants ?? [])
      .filter((grant) => grant.status === 'active')
      .map(({ grantRevision: _revision, status: _status, ...scope }) => scope);
    let grants = active;
    let decisionMode = policy?.decisionMode ?? 'automatic';
    if (command.action.kind === 'set_mode') decisionMode = command.action.decisionMode;
    if (command.action.kind === 'add_rule')
      grants = [...active, { ...command.action.rule, grantRef: `owner-rule:${command.commandId}` }];
    if (command.action.kind === 'allow_request' || command.action.kind === 'decline_request') {
      const projection = await input.request<{ works: CollectiveWorkProjection[] }>(
        `/api/collaboration?collectiveId=${encodeURIComponent(collectiveId)}`,
      );
      const work = ownCurrentProposal(projection.works, command);
      if (command.action.kind === 'decline_request') {
        operation = {
          fingerprint,
          path: '/api/collaboration/work/decline',
          body: {
            serviceInstanceId,
            collectiveId,
            requestId: command.commandId,
            workId: work.workId,
            expectedRevision: work.revision,
          },
        };
        input.storage.setItem(key, JSON.stringify(operation));
        return submit(operation, input.request);
      }
      const proposer = work.proposedBy;
      if (proposer.kind !== 'agent' || !work.proposedRequestKind) throw new Error('这项提议缺少当前猫的判断。');
      grants = [
        ...active,
        {
          grantRef: `owner-rule:${command.commandId}`,
          catIds: [proposer.catId],
          channelIds: [work.sourceLocation.channelId],
          requestingHumanIds: 'channel_members',
          requestKinds: [work.proposedRequestKind],
          expiresAt: null,
          decisionMode: command.action.permission === 'class' ? 'automatic' : 'manual',
          ...(command.action.permission === 'once' ? { sourceEventIds: [work.sourceEventId] } : {}),
        },
      ];
    }
    operation = {
      fingerprint,
      path: '/api/participation/work-policy/register',
      body: {
        ...coordinates,
        requestId: command.commandId,
        expectedRevision: policy?.revision ?? 0,
        decisionMode,
        grants,
      },
    };
    // Persist exact registration BEFORE sending: response loss must replay the same payload, not a newer policy.
    input.storage.setItem(key, JSON.stringify(operation));
  }
  try {
    return await submit(operation, input.request);
  } catch (cause) {
    if (await verifiedPermissionChange(command, operation, input.request))
      throw new HostWorkPolicyCommandError('旧规则已变化；重试只能核对原决定。请明确重新授权。');
    if (cause instanceof HostWorkPolicyCommandError) throw new Error('原提议已变化，请从原消息重新读取。');
    throw cause;
  }
}
async function verifiedPermissionChange(
  command: CollectiveHostWorkPolicyCommand,
  operation: Operation,
  request: ClientRequest,
) {
  if (operation.path !== '/api/participation/work-policy/register') return false;
  try {
    const result = await request<{ policy: CollectiveWorkPolicy | null }>('/api/participation/work-policy/read-owner', {
      method: 'POST',
      body: JSON.stringify({
        serviceInstanceId: command.serviceInstanceId,
        collectiveId: command.collectiveId,
        connectionId: command.connectionId,
      }),
    });
    if (!result.policy || result.policy.ownerHumanId !== command.humanId) return false;
    const registered = result.policy.history.find((entry) => entry.requestId === command.commandId);
    const changed = registered
      ? result.policy.revision > registered.revision
      : result.policy.revision > Number(operation.body.expectedRevision);
    if (!changed) return false;
    if (command.action.kind === 'allow_request') {
      const projection = await request<{ works: CollectiveWorkProjection[] }>(
        `/api/collaboration?collectiveId=${encodeURIComponent(command.collectiveId)}`,
      );
      ownCurrentProposal(projection.works, command);
    }
    return true;
  } catch {
    return false;
  }
}
function ownCurrentProposal(works: CollectiveWorkProjection[], command: CollectiveHostWorkPolicyCommand) {
  const action = command.action;
  if (action.kind !== 'allow_request' && action.kind !== 'decline_request') throw new Error('当前操作没有工作提议。');
  const work = works.find(
    (item) => item.workId === action.workId && item.revision === action.workRevision && item.lifecycle === 'proposed',
  );
  if (
    !work ||
    work.proposedBy.kind !== 'agent' ||
    work.proposedBy.humanId !== command.humanId ||
    work.proposedBy.connectionId !== command.connectionId ||
    !work.proposedRequestKind
  )
    throw new Error('这项提议已变化，或不属于当前 Café。请重新读取。');
  return work;
}
export class HostWorkPolicyCommandError extends Error {
  readonly code = 'permission_changed';
}

async function submit(operation: Operation, request: ClientRequest): Promise<CollectiveWorkPolicyReceipt> {
  if (operation.path.endsWith('/decline')) {
    const result = await request<{ work?: { revision: number }; revision?: number }>(operation.path, {
      method: 'POST',
      body: JSON.stringify(operation.body),
    });
    const workRevision = result.work?.revision ?? result.revision;
    if (!workRevision) throw new Error('暂未确认拒绝结果，请重新读取。');
    return { workRevision };
  }
  const policy = await request<CollectiveWorkPolicy>(operation.path, {
    method: 'POST',
    body: JSON.stringify(operation.body),
  });
  const selected = policy.grants.find(
    (grant) => grant.grantRef === `owner-rule:${operation.body.requestId}` && grant.status === 'active',
  );
  const registeredRevision =
    policy.history?.find((entry) => entry.requestId === operation.body.requestId)?.revision ?? policy.revision;
  if (registeredRevision !== policy.revision)
    throw new HostWorkPolicyCommandError('这次登记后授权已有变化，请重新读取当前规则。');
  return {
    policyRevision: registeredRevision,
    ...(selected ? { grantRef: selected.grantRef, grantRevision: selected.grantRevision } : {}),
  };
}
