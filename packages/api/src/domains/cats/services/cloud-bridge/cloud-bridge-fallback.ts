import type { CatId, CloudBridgeOutboundReceiptV1 } from '@cat-cafe/shared';
import type { BridgeDispatchOutcome, BridgeFallbackReason } from './types.js';

const messageByReason: Record<BridgeFallbackReason, (catId: string) => string> = {
  'no-adapter': (catId) =>
    `未发送给 @${catId}：还没有可用的后台 Host Adapter。请先安装并配对 Chrome 扩展，再绑定目标 ChatGPT 会话。`,
  'needs-binding': (catId) =>
    `☁️ @${catId} 尚未绑定到这个 Thread。这条消息还没有发送。请在原消息旁连接已授权的 ChatGPT 会话，并查看这条消息的发送状态。`,
  'dispatch-failed': (catId) => `投递给 @${catId} 的结果未知：云端桥在拿到投递结果之前出错。`,
  'host-append-failed': (catId) => `投递给 @${catId} 的结果未知：后台 Host Adapter 没有返回可验证的消息回执。`,
  'missing-source-message-id': (catId) =>
    `未发送给 @${catId}：当前 source message ID 缺失，系统已阻止无精确回程锚点的投递。`,
  'incomplete-dispatch-provenance': (catId) =>
    `未发送给 @${catId}：投递来源或回程绑定不完整，系统已阻止无法精确审计的云端调用。`,
  'ambiguous-cloud-cat': (catId) =>
    `未发送给 @${catId}：有多只猫配置了同一个云端 provider，回复无法确定归属。请在猫配置里只保留一只。`,
  'source-retargeted': (catId) =>
    `未发送给 @${catId}：这条消息之前已经发给另一只云端猫，一条消息的回复只能归一只猫。请发一条新消息。`,
  'source-history-unknown': (catId) =>
    `未发送给 @${catId}：无法确认这条较早的消息是否已发给别的云端猫，为免回复记错对象，没有发送。请发一条新消息。`,
};

export interface CloudBridgeAuditContext {
  readonly sourceMessageId: string;
  readonly sourceSender: CloudBridgeOutboundReceiptV1['sourceSender'];
  readonly dispatchInvocationId: string;
}

/** A sent outcome always carries the Host's receipt; an append failure or a last-resort catch may have had an effect. */
function receiptStatus(outcome: BridgeDispatchOutcome): CloudBridgeOutboundReceiptV1['status'] {
  if (outcome.kind === 'sent') return 'sent';
  if (outcome.reason === 'host-append-failed' || outcome.reason === 'dispatch-failed') return 'unknown';
  return 'failed';
}

function receiptTransport(outcome: BridgeDispatchOutcome): CloudBridgeOutboundReceiptV1['transport'] {
  if (outcome.kind === 'sent' || outcome.reason === 'host-append-failed') return 'host';
  return 'none';
}

function buildOutboundReceipt(args: {
  readonly catId: CatId | string;
  readonly outcome: BridgeDispatchOutcome;
  readonly audit: CloudBridgeAuditContext;
}): CloudBridgeOutboundReceiptV1 {
  const status = receiptStatus(args.outcome);
  const disposition =
    args.outcome.idempotentReplay === true
      ? 'replayed'
      : args.outcome.idempotentReplay === false
        ? 'fresh'
        : args.outcome.kind !== 'sent' && status === 'failed'
          ? 'not_attempted'
          : 'unknown';
  return {
    v: 1,
    sourceMessageId: args.audit.sourceMessageId,
    sourceSender: args.audit.sourceSender,
    dispatchInvocationId: args.audit.dispatchInvocationId,
    targetCatId: String(args.catId),
    status,
    transport: receiptTransport(args.outcome),
    ...(args.outcome.kind === 'sent' ? { hostMessageId: args.outcome.hostMessageId } : {}),
    ...(args.outcome.kind === 'error' && args.outcome.failureDiagnostic
      ? { failure: args.outcome.failureDiagnostic }
      : {}),
    idempotency: { keyKind: 'source_message_id', disposition },
  };
}

export function buildFallbackMessageContent(args: {
  reason: BridgeFallbackReason;
  detail?: string;
  catId: CatId | string;
}): string {
  return JSON.stringify({
    type: 'cloud_bridge_status',
    catId: args.catId,
    status: 'unavailable',
    reason: args.reason,
    message: messageByReason[args.reason](String(args.catId)),
    detail: args.detail ?? '',
  });
}

export function buildCloudBridgeStatusContent(args: {
  readonly catId: CatId | string;
  readonly outcome: BridgeDispatchOutcome;
  readonly audit?: CloudBridgeAuditContext;
}): string {
  const outboundReceipt = args.audit ? buildOutboundReceipt({ ...args, audit: args.audit }) : undefined;
  if (args.outcome.kind !== 'sent') {
    const fallback = JSON.parse(
      buildFallbackMessageContent({
        catId: args.catId,
        reason: args.outcome.reason,
        detail: args.outcome.detail ?? (args.outcome.kind === 'error' ? args.outcome.message : undefined),
      }),
    ) as Record<string, unknown>;
    return JSON.stringify({ ...fallback, ...(outboundReceipt ? { outboundReceipt } : {}) });
  }
  return JSON.stringify({
    type: 'cloud_bridge_status',
    catId: args.catId,
    status: 'sent',
    message: `已发送给 @${args.catId}，等待它从 ChatGPT 云端会话回写。`,
    transport: args.outcome.transport,
    hostMessageId: args.outcome.hostMessageId,
    ...(outboundReceipt ? { outboundReceipt } : {}),
  });
}
