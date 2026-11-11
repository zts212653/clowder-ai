import type { LifecycleActiveRun, PluginMentionTarget, TargetResponseStatus } from '@cat-cafe/shared';
import { cloudDispatchReceipt, isNativeCloudTarget } from '@/components/cloud-dispatch-receipt';
import {
  appendedInputReadDisplay,
  pluginDeliveryReceipt,
  projectAppendedInputReceipts,
  projectMessageDispatchAvatars,
} from '@/components/message-dispatch-projection';
import { projectTargetReply } from '@/components/target-response-projection';
import { dispatchReceiptDisplay } from '@/lib/dispatch-receipt-display';
import type { ChatMessage } from '@/stores/chat-types';

/** Read evidence and reply progress remain separate, as in the existing lifecycle projection. */
/** A plugin target's reply status as the receipt states members use. */
const PLUGIN_STATE: Record<TargetResponseStatus, string> = {
  delivering: 'checking',
  waiting: 'delivered',
  processing: 'busy',
  unconfirmed: 'unconfirmed',
  completed: 'read',
  failed: 'failed',
  canceled: 'unknown',
  interrupted: 'failed',
};

export function deliveryView(
  message: ChatMessage,
  timeline: ChatMessage[],
  runs: readonly LifecycleActiveRun[],
  threadId: string,
  plugins: () => readonly PluginMentionTarget[] = () => [],
) {
  return projectMessageDispatchAvatars(message, timeline, runs).map((projection) => {
    const ref = message.lifecycle!.dispatchRefs!.find((r) => r.targetId === projection.targetId)!;
    const read = dispatchReceiptDisplay(ref, projection.phase === 'processing', message.lifecycle);
    const carrier = timeline.find((m) => m.id === projection.statusMessageId);
    if (pluginDeliveryReceipt(carrier)) {
      // only a plugin's receipt reads which plugin the target is
      const plugin = plugins().find((target) => target.id === projection.targetId);
      const reply = projectTargetReply(carrier!, timeline);
      const result = reply?.resultMessageId && reply.resultMessageId !== carrier?.id ? reply.resultMessageId : '';
      return {
        cloud: false,
        canRepeat: false,
        who: plugin?.pluginId ?? projection.targetId,
        state: PLUGIN_STATE[reply?.status ?? 'delivering'],
        time: read.time,
        detail: [],
        mid: projection.statusMessageId ?? '',
        open: result
          ? { act: 'msgJump', args: { t: threadId, mid: result } }
          : { act: 'cafeDelivery', args: { threadId, sourceMessageId: message.id } },
      };
    }
    if (isNativeCloudTarget(projection.targetId)) {
      const receipt = cloudDispatchReceipt(message, projection.targetId, timeline)?.receipt;
      return {
        cloud: true,
        canRepeat: false,
        who: projection.targetId,
        state: receipt
          ? { sent: 'delivered', failed: 'failed', unknown: 'unknown' }[receipt.status]
          : projection.phase === 'processing'
            ? 'checking'
            : 'unknown',
        time: read.time,
        detail:
          receipt?.status === 'failed' && receipt.failure
            ? [receipt.failure.errorCode, receipt.failure.nextAction]
            : [],
        mid: '',
        open: { act: 'cafeDelivery', args: { threadId, sourceMessageId: message.id } },
      };
    }
    const response = timeline.find((m) => m.id === projection.statusMessageId);
    return {
      cloud: false,
      canRepeat: read.state === 'unconfirmed_delivery',
      who: projection.targetId,
      state:
        response?.lifecycle?.kind === 'delivery_failure'
          ? 'failed'
          : read.state === 'read'
            ? 'read'
            : read.state === 'pending'
              ? 'busy'
              : read.state === 'unknown'
                ? 'unknown'
                : read.state === 'checking_delivery'
                  ? 'checking'
                  : read.state === 'unconfirmed_delivery'
                    ? 'unconfirmed'
                    : 'delivered',
      time: read.time,
      detail: [],
      mid: projection.statusMessageId ?? '',
      open:
        response?.lifecycle?.kind === 'response'
          ? { act: 'msgJump', args: { t: threadId, mid: response.id } }
          : { act: 'cafeDelivery', args: { threadId, sourceMessageId: message.id } },
    };
  });
}

export function supplementView(
  response: ChatMessage,
  timeline: ChatMessage[],
  memberName: (id: string) => string,
  userName: string,
  generation?: { messageIds: string[]; complete: boolean },
) {
  const sources = projectAppendedInputReceipts(response, timeline);
  const ids = [
    ...new Set([...sources.map((source) => source.id), ...(generation?.complete ? generation.messageIds : [])]),
  ];
  if (!ids.length) return null;
  const reads = sources.map((source) => appendedInputReadDisplay(source, response));
  return {
    key: `${response.id}:supp`,
    count: ids.length,
    status: reads.map((r) => r.state),
    items: ids.map((mid) => {
      const source = timeline.find((message) => message.id === mid);
      const receiptIndex = sources.findIndex((message) => message.id === mid);
      const catId = source?.from?.kind === 'agent' ? source.from.catId : source?.catId;
      const user = source?.from?.kind === 'user' || source?.type === 'user';
      return {
        key: mid,
        mid,
        who: catId ?? (user ? 'me' : (source?.from ?? '')),
        name: catId ? memberName(catId) : user ? userName : (source?.source?.label ?? ''),
        text: source && !source.extra?.recall ? source.content : '',
        recalled: !!source?.extra?.recall,
        unknown: !source,
        state: receiptIndex >= 0 ? reads[receiptIndex].state : 'unknown', // no receipt for it: the delivery result is unknown
      };
    }),
  };
}
