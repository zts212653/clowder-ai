import {
  latestRecoveryForSource,
  projectCloudBindingRecovery,
  recoveryFromNotice,
} from '@/components/cloud-binding-recovery';
import type { RecoveryIdentity } from '@/components/cloud-binding-recovery-operations';
import { cloudReceiptOf } from '@/components/cloud-dispatch-receipt';
import type { CloudReplyState } from '@/components/cloud-reply-state';
import type { useCloudBindingRecovery } from '@/components/useCloudBindingRecovery';
import type { ChatMessage } from '@/stores/chat-types';

export interface CloudRecoveryTarget {
  mid: string;
  identity: RecoveryIdentity;
  dispatchInvocationId: string;
  bindOnly?: true;
}
export interface CloudRecoveryBinding {
  target: CloudRecoveryTarget;
  controller: ReturnType<typeof useCloudBindingRecovery>;
  result: CloudReplyState;
  sourceAvailable: boolean;
}
export function cloudRecoveryTargets(messages: ChatMessage[], threadId: string): CloudRecoveryTarget[] {
  return messages.flatMap<CloudRecoveryTarget>((notice) => {
    const recovery = recoveryFromNotice(notice);
    const receipt = cloudReceiptOf(notice);
    const identity = recovery ?? receipt;
    if (!identity || identity.targetCatId !== 'gpt-pro' || notice.extra?.recall) return [];
    const source = messages.find((message) => message.id === identity.sourceMessageId);
    const projection = source && projectCloudBindingRecovery(source, messages);
    if (projection?.bindingOnly && receipt?.dispatchInvocationId === projection.attemptId)
      return [
        {
          mid: notice.id,
          dispatchInvocationId: projection.attemptId!,
          bindOnly: true,
          identity: { threadId, sourceMessageId: source!.id, targetCatId: projection.targetCatId },
        },
      ];
    if (
      !recovery ||
      !projection ||
      latestRecoveryForSource(source!, messages)?.dispatchInvocationId !== recovery.dispatchInvocationId ||
      projection.bindingOnly ||
      projection.targetCatId !== recovery.targetCatId ||
      (projection.attemptId && projection.attemptId !== recovery.dispatchInvocationId)
    )
      return [];
    return [
      {
        mid: notice.id,
        dispatchInvocationId: recovery.dispatchInvocationId,
        identity: { threadId, sourceMessageId: source!.id, ...projection },
      },
    ];
  });
}
// The host's part of a recovery card: identity, render type (cloudRecovery.<provider>), the bound address and
// whether the host could send now. The provider's plugin draws the conversation choice and the submit.
export function cloudRecoveryView(binding: CloudRecoveryBinding) {
  const { controller: c, target, result } = binding,
    state = c.loadState;
  const busy =
    ['binding', 'retrying', 'queued'].includes(c.phase) || (state.kind === 'ready' && state.retryState === 'pending');
  const bound = !!target.bindOnly && c.phase === 'connected';
  const load =
    state.kind === 'loading' ? 'loading' : state.kind === 'error' || state.kind === 'unauthorized' ? 'error' : '';
  const provider = state.kind === 'ready' ? state.provider : undefined;
  return {
    recoveries: [
      {
        load,
        args: { ...target.identity, bindOnly: !!target.bindOnly, mid: target.mid },
        bindOnly: !!target.bindOnly,
        key: target.mid,
        type: provider ? `cloudRecovery.${provider}` : 'cloudRecovery',
        boundChatUrl: state.kind === 'ready' ? state.boundChatUrl : null,
        canSubmit:
          !load &&
          (target.bindOnly || !!c.attemptId) &&
          !bound &&
          binding.sourceAvailable &&
          !busy &&
          result.state === 'unverified' &&
          target.identity.deliveryStatus !== 'sent',
        state:
          c.operationError ||
          (!binding.sourceAvailable
            ? 'unavailable'
            : result.state === 'replied'
              ? 'replied'
              : result.state === 'source_replied'
                ? 'source_replied'
                : target.identity.deliveryStatus
                  ? target.identity.deliveryStatus
                  : ''),
        reply: result.state === 'unverified' ? null : { t: target.identity.threadId, mid: result.replyMessageId },
      },
    ],
  };
}
