import { AdapterRegistry } from './adapter-registry.js';
import type { AntigravityAdapterOptions } from './adapters/antigravity-adapter.js';
import { AntigravityMarketplaceAdapter } from './adapters/antigravity-adapter.js';
import type { ClaudeAdapterOptions } from './adapters/claude-adapter.js';
import { ClaudeMarketplaceAdapter } from './adapters/claude-adapter.js';
import type { CodexAdapterOptions } from './adapters/codex-adapter.js';
import { CodexMarketplaceAdapter } from './adapters/codex-adapter.js';
import type { OpenClawAdapterOptions } from './adapters/openclaw-adapter.js';
import { OpenClawMarketplaceAdapter } from './adapters/openclaw-adapter.js';

export interface CreateRegistryOptions {
  claude?: ClaudeAdapterOptions;
  codex?: CodexAdapterOptions;
  openclaw?: OpenClawAdapterOptions;
  antigravity?: AntigravityAdapterOptions;
}

export function createAdapterRegistry(options: CreateRegistryOptions): AdapterRegistry {
  const registry = new AdapterRegistry();

  if (options.claude) registry.register(new ClaudeMarketplaceAdapter(options.claude));
  if (options.codex) registry.register(new CodexMarketplaceAdapter(options.codex));
  if (options.openclaw) registry.register(new OpenClawMarketplaceAdapter(options.openclaw));
  if (options.antigravity) {
    registry.register(new AntigravityMarketplaceAdapter(options.antigravity));
  }

  return registry;
}

export { AdapterRegistry } from './adapter-registry.js';
export { toMcpInstallRequest, validateInstallPlan } from './install-plan-bridge.js';
