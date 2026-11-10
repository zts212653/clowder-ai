/**
 * F333: in-process MCP transport between the session host and one upstream Playwright server.
 *
 * The Host, not the cat's client, is this server's MCP client: it performs `initialize` itself and
 * answers the server's `roots/list` with the API-verified workspace, so a client-declared root can
 * never become Playwright's file boundary (Sol5.6 R1 P1-1). Other server→client requests are refused;
 * server notifications have no stateless channel back to the cat and are dropped.
 */
import { pathToFileURL } from 'node:url';

export type JsonRpc = { jsonrpc: '2.0'; id?: string | number; method?: string; params?: unknown } & Record<
  string,
  unknown
>;

export class LoopbackTransport {
  onmessage?: (message: JsonRpc) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private readonly pending = new Map<string | number, (message: JsonRpc) => void>();
  private closed = false;

  constructor(private readonly workspace: string) {}

  async start(): Promise<void> {}

  /** Server → client. */
  async send(message: JsonRpc): Promise<void> {
    if (message.method === undefined && message.id !== undefined) {
      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      const reply: JsonRpc =
        message.method === 'roots/list'
          ? { jsonrpc: '2.0', id: message.id, result: { roots: [{ uri: pathToFileURL(this.workspace).href }] } }
          : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Not supported by the Host client' } };
      queueMicrotask(() => this.onmessage?.(reply));
    }
  }

  /** Client → server request; resolves with the server's response for the same id. */
  request(message: JsonRpc): Promise<JsonRpc> {
    if (this.closed) return Promise.reject(new Error('browser_session_closed'));
    if (message.id === undefined) return Promise.reject(new Error('request_without_id'));
    return new Promise((resolve) => {
      this.pending.set(message.id as string | number, resolve);
      this.onmessage?.(message);
    });
  }

  notify(message: JsonRpc): void {
    if (!this.closed) this.onmessage?.(message);
  }

  get inFlight(): number {
    return this.pending.size;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [id, resolve] of this.pending)
      resolve({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Browser session closed' } });
    this.pending.clear();
    this.onclose?.();
  }
}
