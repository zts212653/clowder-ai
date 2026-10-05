import type { CompanionErrorCode } from '@clowder-ai/plugin-contract';
import type { FastifyInstance } from 'fastify';

export class CompanionBridgeError extends Error {
  constructor(readonly code: CompanionErrorCode) {
    super(code);
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CompanionBridgeError('unavailable');
  return value as Record<string, unknown>;
}

/** Calls the installing Fastify Host itself through its ordinary session/route
 * boundary. No renderer-supplied origin, principal, header or path is accepted.
 */
export class CompanionOwnerClient {
  private cookie = '';
  private login: Promise<void> | undefined;
  constructor(
    private readonly options: {
      app: FastifyInstance;
      ownerUserId: string;
      origin: string;
      assertCurrent(): Promise<void>;
    },
  ) {
    const origin = new URL(options.origin);
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
      origin.origin !== options.origin
    )
      throw new Error('companion requires its local Host origin');
  }

  async request(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
    payload?: object,
  ): Promise<Record<string, unknown>> {
    await this.options.assertCurrent();
    await this.authenticate();
    await this.options.assertCurrent();
    return this.send(path, method, payload);
  }

  /** Preserve the canonical route's settlement facts for settings receipts. */
  async requestResponse(path: string, method: 'GET' | 'POST' | 'PUT' = 'GET', payload?: object) {
    await this.options.assertCurrent();
    await this.authenticate();
    await this.options.assertCurrent();
    return this.sendResponse(path, method, payload);
  }

  /** Cleanup may outlive a feature lease, but can only delete the Host-issued call
   * already owned by this client. It cannot mint a new session after revocation. */
  async closeCall(callId: string): Promise<void> {
    if (!this.cookie) throw new CompanionBridgeError('session_required');
    await this.send(`/api/concierge/live/${encodeURIComponent(callId)}`, 'DELETE');
  }

  private async authenticate(): Promise<void> {
    if (this.cookie) return;
    this.login ??= (async () => {
      const response = await this.options.app.inject({ method: 'GET', url: '/api/session' });
      if (response.statusCode !== 200 || record(response.json()).userId !== this.options.ownerUserId)
        throw new CompanionBridgeError('permission_required');
      const header = response.headers['set-cookie'];
      if (!header) throw new CompanionBridgeError('session_required');
      this.cookie = (Array.isArray(header) ? header : [header]).map((value) => value.split(';')[0]).join('; ');
    })();
    try {
      await this.login;
    } finally {
      this.login = undefined;
    }
  }

  private async send(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    payload?: object,
  ): Promise<Record<string, unknown>> {
    const response = await this.sendResponse(path, method, payload);
    if (method === 'DELETE' && response.statusCode === 404) return { stopped: true };
    const body = response.body;
    if (response.statusCode >= 200 && response.statusCode < 300) return body;
    if (response.statusCode === 401 || response.statusCode === 403)
      throw new CompanionBridgeError('permission_required');
    if (response.statusCode === 404 && method === 'GET' && /^\/api\/concierge\/live\/[^/]+$/.test(path))
      throw new CompanionBridgeError('session_required');
    if (body.code === 'live_call_active') throw new CompanionBridgeError('busy');
    if (body.code === 'live_selection_changed') throw new CompanionBridgeError('selection_changed');
    if (
      body.code === 'live_carrier_unavailable' ||
      body.code === 'live_carrier_ambiguous' ||
      body.code === 'live_duty_unavailable'
    )
      throw new CompanionBridgeError('carrier_unavailable');
    throw new CompanionBridgeError('unavailable');
  }

  private async sendResponse(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    payload?: object,
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const response = await this.options.app.inject({
      method,
      url: path,
      headers: { cookie: this.cookie, origin: this.options.origin },
      ...(payload ? { payload } : {}),
    });
    if (method === 'DELETE' && response.statusCode === 404)
      return { statusCode: response.statusCode, body: { stopped: true } };
    let body: Record<string, unknown>;
    try {
      body = record(response.json());
    } catch {
      throw new CompanionBridgeError('unavailable');
    }
    return { statusCode: response.statusCode, body };
  }
}
