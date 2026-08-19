/**
 * F254 Phase C — RuntimeCapabilityDescriptor (AC-C1)
 *
 * Structures runtime modes (headless-p / interactive / bg-cron / cloud / connector)
 * so Phase A/B gate behavior is parameterized by descriptor, not hardcoded.
 *
 * Descriptor is derived from (provider, carrierTier) — P4 single source of truth.
 * Never hand-maintained lookup tables.
 */

import type { CarrierTier } from '../agents/providers/carrier-health.js';

// --- Descriptor interface ---

/**
 * Runtime capability descriptor — drives freshness gate behavior.
 *
 * Phase C scope uses `canReceiveHeldResponse` and `canReceiveContentFreeNotice`.
 * Other fields are defined for future extensibility (busyDeliveryMode, etc.).
 */
export interface RuntimeCapabilityDescriptor {
  /** Carrier mode: mapped from CarrierTier */
  carrier: string; // 'headless-p' | 'interactive' | 'bg-cron' | 'cloud' | 'connector'
  /** Provider/driver: from cat-config.json */
  driver: string; // 'anthropic' | 'openai' | 'google' | etc.

  // --- Freshness Gate capabilities (Phase C active) ---
  /** Can the cat receive a "held" gate decision and act on it? */
  canReceiveHeldResponse: boolean;
  /** Can the cat receive content-free unseen-message notices on read-only tools? */
  canReceiveContentFreeNotice: boolean;

  // --- Interaction capabilities (future extensibility) ---
  /** How the system delivers messages to a busy cat */
  busyDeliveryMode: 'gated' | 'direct' | 'steer';
  /** Can the cat ask a human synchronously (interactive terminal only)? */
  canAskHumanSync: boolean;
  /** Is background bash reliable (headless -p known issue: no bg bash)? */
  backgroundBashReliable: boolean;

  // --- Security ---
  /** Permission mode name */
  permissionMode: string;
}

export interface FreshnessDescriptorProviderConfig {
  clientId?: string;
  provider?: string;
}

// --- Carrier tier mapping ---

/**
 * Map CarrierTier → spec carrier name.
 * Unknown values default to 'headless-p' (same as resolveTargetTier default in carrier factory).
 */
export function carrierTierToCarrierName(tier: string): string {
  switch (tier) {
    case 'interactive_pty':
      return 'interactive';
    case 'print_sdk':
      return 'headless-p';
    case 'bg_daemon':
      return 'bg-cron';
    case 'api_key':
      return 'cloud';
    default:
      return 'headless-p'; // Same default as claude-carrier-factory.ts
  }
}

// --- Provider capability profiles ---

/** Providers that run async when the carrier is explicitly cloud/api_key. */
const ASYNC_CLOUD_PROVIDERS = new Set(['openai', 'openai-chatgpt-pro']);

/** Providers whose name alone is enough to prove cloud-only transport. */
const PROVIDER_ONLY_CLOUD_PROVIDERS = new Set(['openai-chatgpt-pro']);

/**
 * Carriers that cannot meaningfully act on held responses or notices.
 * bg-cron jobs are fire-and-forget — holding their message doesn't help.
 */
const RESTRICTED_CARRIERS = new Set(['bg-cron']);

// --- Derivation function ---

/**
 * Derive RuntimeCapabilityDescriptor from (provider, carrierTier).
 *
 * AC-C1: "Descriptor 从 driver 定义派生，不手维护查表"
 * The logic is compositional: carrier determines transport capabilities,
 * provider determines interaction model. Their intersection yields the descriptor.
 *
 * @param provider - Cat's provider from cat-config.json (e.g. 'anthropic', 'openai', 'google')
 * @param carrierTier - Active carrier tier (e.g. 'print_sdk', 'interactive_pty')
 */
export function descriptorFromDriver(provider: string, carrierTier: CarrierTier | string): RuntimeCapabilityDescriptor {
  const carrier = carrierTierToCarrierName(carrierTier);

  // Carrier-level restrictions: bg-cron and certain cloud combos
  const carrierRestricted = RESTRICTED_CARRIERS.has(carrier);

  // Provider-level restrictions: async cloud providers can't use interactive freshness
  const isAsyncCloud = carrier === 'cloud' && ASYNC_CLOUD_PROVIDERS.has(provider);

  // Freshness capabilities: both carrier AND provider must support it
  const canReceiveHeldResponse = !carrierRestricted && !isAsyncCloud;
  const canReceiveContentFreeNotice = !carrierRestricted && !isAsyncCloud;

  return {
    carrier,
    driver: provider,
    canReceiveHeldResponse,
    canReceiveContentFreeNotice,
    busyDeliveryMode: carrier === 'headless-p' ? 'gated' : carrier === 'interactive' ? 'gated' : 'direct',
    canAskHumanSync: carrier === 'interactive',
    backgroundBashReliable: carrier !== 'headless-p', // Known -p limitation
    permissionMode: carrier === 'interactive' ? 'default' : 'none',
  };
}

/**
 * Resolve the provider identity used by RuntimeCapabilityDescriptor.
 *
 * `clientId` is the local client family (e.g. openai), while `provider` can
 * carry a more specific runtime marker (e.g. openai-chatgpt-pro cloud-only).
 * Freshness gates need the specific provider when present so cloud-only cats
 * do not become fail-open just because their client family is openai.
 */
export function resolveFreshnessDescriptorProvider(config?: FreshnessDescriptorProviderConfig | null): string {
  return config?.provider ?? config?.clientId ?? 'unknown';
}

// --- Provider-only fallback (gpt52 terminal review P1 fix) ---

/**
 * Derive descriptor from provider alone when carrierTier is unavailable.
 *
 * Some services don't have _carrierTier on their service wrapper, so the
 * producer side (invoke-single-cat) may not write carrierTier to Redis. The
 * consumer side needs a fallback only when provider identity alone proves the
 * transport is cloud-only.
 *
 * - PROVIDER_ONLY_CLOUD_PROVIDERS → api_key carrier → restricted
 * - All others → undefined (= DEFAULT_DESCRIPTOR = fail-open, which is correct
 *   for local/headless providers like openai Codex, google, kimi, antigravity)
 *
 * When Phase D adds proper producer-side wiring for all services, the
 * primary path (carrierTier from Redis) takes precedence and this fallback
 * becomes dead code.
 */
export function descriptorFromProviderFallback(provider: string): RuntimeCapabilityDescriptor | undefined {
  if (PROVIDER_ONLY_CLOUD_PROVIDERS.has(provider)) {
    return descriptorFromDriver(provider, 'api_key');
  }
  // Non-async providers: fail-open is correct (same as DEFAULT_DESCRIPTOR)
  return undefined;
}

// --- Default descriptor (fail-open) ---

/**
 * Default descriptor: fully permissive.
 * Used when no carrier/provider info is available (backward compat, fail-open).
 */
export const DEFAULT_DESCRIPTOR: RuntimeCapabilityDescriptor = {
  carrier: 'unknown',
  driver: 'unknown',
  canReceiveHeldResponse: true,
  canReceiveContentFreeNotice: true,
  busyDeliveryMode: 'gated',
  canAskHumanSync: false,
  backgroundBashReliable: true,
  permissionMode: 'default',
};
