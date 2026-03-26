/**
 * MediaHub — Base Provider
 * F139: Abstract base class for media generation providers.
 * New providers implement this interface and register via the registry.
 */

import type {
  GenerationRequest,
  HealthCheckResult,
  MediaCapability,
  ProviderInfo,
  StatusResult,
  SubmitResult,
} from './types.js';

/** Contract every provider must implement */
export interface MediaProvider {
  readonly info: ProviderInfo;

  /** Submit a generation job. Returns immediately with a job handle. */
  submit(request: GenerationRequest): Promise<SubmitResult>;

  /** Poll provider for job status + result URL when done. */
  queryStatus(providerTaskId: string): Promise<StatusResult>;

  /** Whether this provider supports the given capability */
  supports(capability: MediaCapability): boolean;

  /** Optional: verify credentials are still valid via lightweight API call */
  checkHealth?(): Promise<HealthCheckResult>;
}

/**
 * Provider Registry — singleton that holds all registered providers.
 * Providers register themselves at startup based on available credentials.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, MediaProvider>();

  register(provider: MediaProvider): void {
    if (this.providers.has(provider.info.id)) {
      throw new Error(`Provider already registered: ${provider.info.id}`);
    }
    this.providers.set(provider.info.id, provider);
  }

  unregister(id: string): boolean {
    return this.providers.delete(id);
  }

  get(id: string): MediaProvider | undefined {
    return this.providers.get(id);
  }

  list(): ProviderInfo[] {
    return [...this.providers.values()].map((p) => p.info);
  }

  listByCapability(capability: MediaCapability): ProviderInfo[] {
    return [...this.providers.values()].filter((p) => p.supports(capability)).map((p) => p.info);
  }

  get size(): number {
    return this.providers.size;
  }
}
