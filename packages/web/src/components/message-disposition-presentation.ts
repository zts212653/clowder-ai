import type { FreshnessCarrierCapability, QueueAuthorIntentReceipt } from '@cat-cafe/shared';

const PROVIDERS = new Set(['openai_codex', 'anthropic', 'kimi', 'other']);
const CARRIERS = new Set([
  'codex_app_server',
  'codex_exec_json',
  'claude_print_sdk',
  'claude_stream_json',
  'kimi_stream_json',
  'mcp_result_piggyback',
  'other',
]);
const DELIVERY_SEMANTICS = new Set([
  'exact_active_turn',
  'queued_internal_turn',
  'mcp_result_piggyback',
  'unsupported',
  'undeclared',
]);

export type FreshnessCarrierSupport = 'exact' | 'unsupported' | 'undeclared';

export function parseFreshnessCarrierCapability(value: unknown): FreshnessCarrierCapability | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.provider !== 'string' ||
    typeof candidate.carrier !== 'string' ||
    typeof candidate.deliverySemantics !== 'string' ||
    !PROVIDERS.has(candidate.provider) ||
    !CARRIERS.has(candidate.carrier) ||
    !DELIVERY_SEMANTICS.has(candidate.deliverySemantics)
  ) {
    return undefined;
  }
  return candidate as unknown as FreshnessCarrierCapability;
}

export function classifyFreshnessCarrierSupport(
  capabilities: readonly (FreshnessCarrierCapability | undefined)[],
): FreshnessCarrierSupport {
  if (
    capabilities.length === 0 ||
    capabilities.some((capability) => !capability || capability.deliverySemantics === 'undeclared')
  ) {
    return 'undeclared';
  }
  return capabilities.every((capability) => capability?.deliverySemantics === 'exact_active_turn')
    ? 'exact'
    : 'unsupported';
}

export function carrierCapabilityLabel(capability: FreshnessCarrierCapability | undefined): string {
  if (!capability || capability.deliverySemantics === 'undeclared') return '能力未声明';
  return `${capability.provider} · ${capability.carrier} · ${capability.deliverySemantics}`;
}

export function authorIntentLabel(intent: QueueAuthorIntentReceipt | undefined): string | undefined {
  if (!intent) return undefined;
  if (intent.requested === 'continue_current' && intent.effective === 'continue_current') {
    return '接着当前工作 · 等待本轮读取';
  }
  if (intent.requested === 'continue_current') {
    return '接着当前工作 · 未在本轮读取，已转下一件工作';
  }
  return '下一件工作 · 本轮不可见';
}

export function unsupportedCarrierCopy(support: FreshnessCarrierSupport, noun = '读取'): string | undefined {
  if (support === 'exact') return undefined;
  return support === 'undeclared' ? `能力未声明 · 按下一件工作处理` : `当前接入不支持本轮${noun}`;
}
