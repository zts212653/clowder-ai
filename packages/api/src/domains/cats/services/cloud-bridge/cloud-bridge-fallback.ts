import type { CatId } from '@cat-cafe/shared';
import type { BridgeFallbackReason } from './types.js';

export function buildFallbackMessageContent(args: {
  reason: BridgeFallbackReason;
  detail?: string;
  catId: CatId | string;
}): string {
  const headlineByReason: Record<BridgeFallbackReason, string> = {
    'no-adapter': `Cloud cat @${args.catId} has no background Host Adapter for this conversation; foreground automation remains disabled.`,
    'adapter-not-ready': `Cloud cat @${args.catId} bridge unavailable: PinchTab Chrome unreachable or not logged in to ChatGPT.`,
    'inject-failed': `Cloud cat @${args.catId} bridge inject failed (DOM selector or eval error).`,
    'invalid-captured-url': `Cloud cat @${args.catId} bridge captured a non-canonical ChatGPT URL; binding not written.`,
    'host-append-failed': `Cloud cat @${args.catId} host append_message failed; no foreground UI fallback was attempted.`,
    'missing-idempotency-key': `Cloud cat @${args.catId} host append was blocked because the source message ID was unavailable.`,
  };
  return JSON.stringify({
    type: 'b1c_bridge_fallback',
    catId: args.catId,
    reason: args.reason,
    headline: headlineByReason[args.reason],
    detail: args.detail ?? '',
  });
}
