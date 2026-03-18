/**
 * RemoteLimbNode — F126 Phase C
 *
 * ILimbNode proxy that forwards invoke/healthCheck to a remote HTTP endpoint.
 * Remote nodes register themselves via /api/limb/register, then Cat Café
 * creates a RemoteLimbNode to represent them in the LimbRegistry.
 */

import type { ILimbNode, LimbCapability, LimbInvokeResult, LimbNodeStatus } from '@cat-cafe/shared';

export interface RemoteLimbNodeConfig {
  nodeId: string;
  displayName: string;
  platform: string;
  capabilities: LimbCapability[];
  /** Remote node's HTTP endpoint (e.g. "http://192.168.1.100:8080") */
  endpointUrl: string;
  /** Auth token for the remote node */
  apiKey?: string;
  /** Request timeout in ms */
  timeoutMs?: number;
  /** Inject custom fetch for testing */
  fetchFn?: typeof fetch;
}

export class RemoteLimbNode implements ILimbNode {
  readonly nodeId: string;
  readonly displayName: string;
  readonly platform: string;
  readonly capabilities: LimbCapability[];
  private readonly endpointUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: RemoteLimbNodeConfig) {
    this.nodeId = config.nodeId;
    this.displayName = config.displayName;
    this.platform = config.platform;
    this.capabilities = config.capabilities;
    this.endpointUrl = config.endpointUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  async register(): Promise<void> {
    // No-op — registration is handled by the API route + pairing flow
  }

  async deregister(): Promise<void> {
    // No-op — deregistration is handled by the API route
  }

  async invoke(command: string, params: Record<string, unknown>): Promise<LimbInvokeResult> {
    try {
      const response = await this.fetchFn(`${this.endpointUrl}/invoke`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ command, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        return { success: false, error: `Remote node returned ${response.status}: ${response.statusText}` };
      }

      return (await response.json()) as LimbInvokeResult;
    } catch (err) {
      return { success: false, error: `Remote invoke failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async healthCheck(): Promise<LimbNodeStatus> {
    try {
      const response = await this.fetchFn(`${this.endpointUrl}/health`, {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) return 'degraded';

      const data = (await response.json()) as { status?: string };
      const status = data.status;
      if (status === 'online' || status === 'busy' || status === 'degraded' || status === 'offline') {
        return status;
      }
      return 'online';
    } catch {
      return 'offline';
    }
  }
}
