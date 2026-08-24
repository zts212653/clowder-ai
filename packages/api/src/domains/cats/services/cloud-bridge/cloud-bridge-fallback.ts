import type { CatId, CloudBridgeOutboundReceiptV1 } from '@cat-cafe/shared';
import type { BridgeDispatchOutcome, BridgeFallbackReason } from './types.js';

const messageByReason: Record<BridgeFallbackReason, (catId: string) => string> = {
  'no-adapter': (catId) =>
    `未发送给 @${catId}：还没有可用的后台 Host Adapter。请先安装并配对 Chrome 扩展，再绑定目标 ChatGPT 会话；前台自动化保持关闭。`,
  'adapter-not-ready': (catId) =>
    `未发送给 @${catId}：旧版 PinchTab 桥不可用或 ChatGPT 尚未登录；前台自动化不会自动接管。`,
  'inject-failed': (catId) =>
    `投递给 @${catId} 的结果未知：页面桥未返回可验证回执，请检查登录态、目标标签页和页面版本。`,
  'invalid-captured-url': (catId) => `投递给 @${catId} 的结果未知：桥接结果不是可验证的 ChatGPT 会话地址。`,
  'host-append-failed': (catId) => `投递给 @${catId} 的结果未知：后台 Host Adapter 没有返回可验证的消息回执。`,
  'missing-source-message-id': (catId) =>
    `未发送给 @${catId}：当前 source message ID 缺失，系统已阻止无精确回程锚点的投递。`,
  'incomplete-dispatch-provenance': (catId) =>
    `未发送给 @${catId}：投递来源或回程绑定不完整，系统已阻止无法精确审计的云端调用。`,
  'legacy-delivery-unverified': (catId) =>
    `投递给 @${catId} 的结果未知：旧版页面桥没有返回可验证的 Host message receipt。`,
};

export interface CloudBridgeAuditContext {
  readonly sourceMessageId: string;
  readonly sourceSender: CloudBridgeOutboundReceiptV1['sourceSender'];
  readonly dispatchInvocationId: string;
}

function receiptStatus(outcome: BridgeDispatchOutcome): CloudBridgeOutboundReceiptV1['status'] {
  if (outcome.kind === 'sent') {
    return outcome.transport === 'host' && Boolean(outcome.hostMessageId) ? 'sent' : 'unknown';
  }
  if (
    outcome.reason === 'host-append-failed' ||
    outcome.reason === 'inject-failed' ||
    outcome.reason === 'invalid-captured-url'
  ) {
    return 'unknown';
  }
  return 'failed';
}

function receiptTransport(outcome: BridgeDispatchOutcome): CloudBridgeOutboundReceiptV1['transport'] {
  if (outcome.kind === 'sent') return outcome.transport ?? 'legacy-pinchtab';
  if (outcome.reason === 'host-append-failed') return 'host';
  if (
    outcome.reason === 'inject-failed' ||
    outcome.reason === 'invalid-captured-url' ||
    outcome.reason === 'adapter-not-ready'
  ) {
    return 'legacy-pinchtab';
  }
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
    ...(args.outcome.kind === 'sent' && args.outcome.hostMessageId
      ? { hostMessageId: args.outcome.hostMessageId }
      : {}),
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

function unverifiedSentOutcome(
  outcome: BridgeDispatchOutcome,
): Extract<BridgeDispatchOutcome, { kind: 'sent' }> | undefined {
  if (outcome.kind !== 'sent' || (outcome.transport === 'host' && outcome.hostMessageId)) return undefined;
  return outcome;
}

export function buildCloudBridgeStatusContent(args: {
  readonly catId: CatId | string;
  readonly outcome: BridgeDispatchOutcome;
  readonly audit?: CloudBridgeAuditContext;
}): string {
  const outboundReceipt = args.audit ? buildOutboundReceipt({ ...args, audit: args.audit }) : undefined;
  const unverifiedSent = unverifiedSentOutcome(args.outcome);
  if (unverifiedSent) {
    return JSON.stringify({
      type: 'cloud_bridge_status',
      catId: args.catId,
      status: 'unavailable',
      reason: 'legacy-delivery-unverified',
      message: messageByReason['legacy-delivery-unverified'](String(args.catId)),
      transport: unverifiedSent.transport ?? 'legacy-pinchtab',
      ...(outboundReceipt ? { outboundReceipt } : {}),
    });
  }
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
    ...(args.outcome.transport ? { transport: args.outcome.transport } : {}),
    ...(args.outcome.hostMessageId ? { hostMessageId: args.outcome.hostMessageId } : {}),
    ...(outboundReceipt ? { outboundReceipt } : {}),
  });
}
