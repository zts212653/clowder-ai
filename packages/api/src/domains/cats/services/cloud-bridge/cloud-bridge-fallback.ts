import type { CatId } from '@cat-cafe/shared';
import type { BridgeDispatchOutcome, BridgeFallbackReason } from './types.js';

const messageByReason: Record<BridgeFallbackReason, (catId: string) => string> = {
  'no-adapter': (catId) =>
    `未发送给 @${catId}：还没有可用的后台 Host Adapter。请先安装并配对 Chrome 扩展，再绑定目标 ChatGPT 会话；前台自动化保持关闭。`,
  'adapter-not-ready': (catId) =>
    `未发送给 @${catId}：旧版 PinchTab 桥不可用或 ChatGPT 尚未登录；前台自动化不会自动接管。`,
  'inject-failed': (catId) => `未发送给 @${catId}：ChatGPT 页面投递失败，请检查登录态、目标标签页和页面版本。`,
  'invalid-captured-url': (catId) => `未发送给 @${catId}：桥接结果不是可验证的 ChatGPT 会话地址。`,
  'host-append-failed': (catId) => `未发送给 @${catId}：后台 Host Adapter 没有返回可验证的消息回执。`,
  'missing-idempotency-key': (catId) => `未发送给 @${catId}：当前 source message ID 缺失，系统已阻止不可去重的投递。`,
};

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
}): string {
  if (args.outcome.kind !== 'sent') {
    return buildFallbackMessageContent({
      catId: args.catId,
      reason: args.outcome.reason,
      detail: args.outcome.detail ?? (args.outcome.kind === 'error' ? args.outcome.message : undefined),
    });
  }
  return JSON.stringify({
    type: 'cloud_bridge_status',
    catId: args.catId,
    status: 'sent',
    message: `已发送给 @${args.catId}，等待它从 ChatGPT 云端会话回写。`,
    ...(args.outcome.transport ? { transport: args.outcome.transport } : {}),
    ...(args.outcome.hostMessageId ? { hostMessageId: args.outcome.hostMessageId } : {}),
  });
}
