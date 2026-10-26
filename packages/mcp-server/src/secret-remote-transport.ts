import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** Preserve native HTTP/SSE negotiation, without retrying auth or arbitrary failures. */
export class SecretRemoteTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  private active: Transport;
  private first = true;
  private negotiating = false;

  constructor(
    private url: URL,
    private headers: Record<string, string>,
    private mode?: string,
    private requestHeaders?: () => Record<string, string>,
    private requestSignal?: () => AbortSignal | undefined,
  ) {
    const options = { requestInit: { headers }, ...(requestHeaders ? { fetch: this.authenticatedFetch } : {}) };
    this.active =
      mode === 'sse' ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options);
    this.bind(this.active);
  }

  private authenticatedFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(this.requestHeaders?.() ?? {})) headers.set(name, value);
    const boundSignal = this.requestSignal?.();
    const signal =
      boundSignal && init?.signal ? AbortSignal.any([boundSignal, init.signal]) : (boundSignal ?? init?.signal);
    return fetch(input, { ...init, headers, signal, redirect: 'error' });
  };

  private incompatible(error: unknown): boolean {
    return (
      error instanceof StreamableHTTPError && typeof error.code === 'number' && [404, 405, 501].includes(error.code)
    );
  }

  private bind(transport: Transport) {
    transport.onmessage = (message, extra) => this.onmessage?.(message, extra);
    transport.onclose = () => {
      if (this.active === transport) this.onclose?.();
    };
    transport.onerror = (error) => {
      // Stateless shared requests own their errors and cancellation. send()
      // rejects that RPC; closing the carrier here would cancel unrelated RPCs.
      if (this.requestHeaders) return;
      if (!(this.negotiating && this.incompatible(error))) this.onerror?.(error);
    };
  }

  start() {
    return this.active.start();
  }
  close() {
    return this.active.close();
  }
  setProtocolVersion(version: string) {
    this.active.setProtocolVersion?.(version);
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions) {
    this.negotiating = this.mode === 'auto' && this.first && 'method' in message && message.method === 'initialize';
    this.first = false;
    try {
      await this.active.send(message, options);
    } catch (error) {
      if (!this.negotiating || !this.incompatible(error)) throw error;
      const previous = this.active;
      this.active = new SSEClientTransport(this.url, { requestInit: { headers: this.headers } });
      this.negotiating = false;
      this.bind(this.active);
      await previous.close();
      await this.active.start();
      await this.active.send(message, options);
    } finally {
      this.negotiating = false;
    }
  }
}
