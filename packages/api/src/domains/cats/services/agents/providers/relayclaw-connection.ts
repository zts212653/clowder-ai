import type { RelayClawWsFrame } from '@cat-cafe/shared';

export class FrameQueue {
  private queue: (RelayClawWsFrame | null)[] = [];
  private waitResolve: ((value: RelayClawWsFrame | null) => void) | null = null;

  put(frame: RelayClawWsFrame | null): void {
    if (this.waitResolve) {
      const resolve = this.waitResolve;
      this.waitResolve = null;
      resolve(frame);
      return;
    }
    this.queue.push(frame);
  }

  take(): Promise<RelayClawWsFrame | null> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift()!);
    }
    return new Promise<RelayClawWsFrame | null>((resolve) => {
      this.waitResolve = resolve;
    });
  }

  abort(): void {
    this.put(null);
  }
}

export interface RelayClawConnection {
  ensureConnected(url: string, signal?: AbortSignal): Promise<void>;
  isOpen(): boolean;
  send(payload: unknown): void;
  close(): void;
}

export interface RelayClawConnectionFactory {
  (requestQueues: Map<string, FrameQueue>): RelayClawConnection;
}

interface RelayClawConnectionManagerOptions {
  requestQueues: Map<string, FrameQueue>;
  wsFactory?: (url: string) => WebSocket;
}

export class RelayClawConnectionManager implements RelayClawConnection {
  private readonly requestQueues: Map<string, FrameQueue>;
  private readonly wsFactory: (url: string) => WebSocket;
  private ws: WebSocket | null = null;
  private serverReady = false;
  private connectPromise: Promise<void> | null = null;

  constructor(options: RelayClawConnectionManagerOptions) {
    this.requestQueues = options.requestQueues;
    this.wsFactory = options.wsFactory ?? ((url) => new WebSocket(url));
  }

  async ensureConnected(url: string, signal?: AbortSignal): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN && this.serverReady) return;
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }
    this.connectPromise = this.connect(url, signal);
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.serverReady;
  }

  send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(JSON.stringify(payload));
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
    this.serverReady = false;
  }

  private connect(url: string, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Aborted before connect'));
        return;
      }

      const ws = this.wsFactory(url);
      this.ws = ws;
      this.serverReady = false;

      const onAbort = () => {
        ws.close();
        reject(new Error('Connection aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => signal?.removeEventListener('abort', onAbort);

      ws.addEventListener('message', (event: MessageEvent) => {
        const data = typeof event.data === 'string' ? event.data : String(event.data);
        let frame: RelayClawWsFrame;
        try {
          frame = JSON.parse(data) as RelayClawWsFrame;
        } catch {
          return;
        }

        if (frame.type === 'event' && frame.event === 'connection.ack') {
          this.serverReady = true;
          cleanup();
          resolve();
          return;
        }

        const requestId = frame.request_id;
        if (!requestId) return;
        const queue = this.requestQueues.get(requestId);
        if (!queue) return;
        queue.put(frame);
        if (frame.is_complete === true || frame.payload?.is_complete === true) {
          queue.put(null);
        }
      });

      ws.addEventListener('error', () => {
        cleanup();
        if (!this.serverReady) {
          reject(new Error(`WebSocket connection to ${url} failed`));
        }
      });

      ws.addEventListener('close', () => {
        this.serverReady = false;
        this.ws = null;
        for (const queue of this.requestQueues.values()) {
          queue.put({
            channel_id: '',
            payload: {
              event_type: 'chat.error',
              error: 'jiuwenClaw WebSocket connection closed unexpectedly',
              is_complete: true,
            },
            is_complete: true,
          });
          queue.abort();
        }
        cleanup();
        reject(new Error('WebSocket closed before ready'));
      });
    });
  }
}
