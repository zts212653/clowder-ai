/**
 * F333: MCP state inside the shared browser process.
 *
 * Only the API reaches this server: every request carries the per-boot key the API received over
 * IPC, plus identity the API verified (thread, workspace, opaque invocation+connection binding).
 * Callback tokens never arrive here — `browser_run_code_unsafe` is arbitrary code execution inside
 * this whole process (every thread's pages, the shared login, and the process itself).
 *
 * The HTTP edge is stateless (no Mcp-Session-Id), so an idle reap or a restarted process never
 * strands a client on a dead session id (Sol5.6 R1 P1-2). Each binding keeps one long-lived upstream
 * server behind a LoopbackTransport; the Host is that server's MCP client, so the workspace — never a
 * client-declared root — is Playwright's file boundary (P1-1). Lost state is rebuilt on demand.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { type JsonRpc, LoopbackTransport } from './browser-loopback-transport.js';
import { type PoolContext, type ThreadView, WorkspaceBrowser } from './shared-browser-pool.js';

export const BROWSER_KEY_HEADER = 'x-cat-cafe-browser-key';
export const BROWSER_THREAD_HEADER = 'x-cat-cafe-browser-thread';
export const BROWSER_WORKSPACE_HEADER = 'x-cat-cafe-browser-workspace';
export const BROWSER_BINDING_HEADER = 'x-cat-cafe-browser-binding';

export interface McpServerLike {
  connect(transport: LoopbackTransport): Promise<void>;
  close(): Promise<void>;
}

export interface SessionHostDeps {
  key: string;
  /** Upstream `createConnection(config, contextGetter)`. */
  createServer(config: Record<string, unknown>, contextGetter: () => Promise<unknown>): Promise<McpServerLike>;
  launch(workspace: string): Promise<PoolContext>;
  now?: () => number;
  /** Test seam; defaults to REQUEST_DEADLINE_MS. */
  requestDeadlineMs?: number;
  /**
   * Called once when a call outlives its deadline. The process owner must end this process: the
   * late call keeps running inside it and can still act on shared pages (Sol5.6 R3).
   */
  onPoisoned?: () => void;
}

/** A closed CLI does not always say goodbye; idle state is released, and rebuilt if it returns. */
const SESSION_IDLE_MS = 30 * 60_000;
/** A thread's pages stay this long after its last state closes, so a cat can come back to them. */
const THREAD_IDLE_MS = 30 * 60_000;
/** Concurrent bindings (live + being created); beyond this the least recently used idle one is released. */
const MAX_STATES = 128;
/**
 * A call that never settles (e.g. a `browser_run_code_unsafe` promise that never resolves) still
 * heartbeats, so the API watchdog cannot see it. Each call therefore has its own deadline: it fails
 * once and nothing is retried (Sol5.6 R2 P1-3). Playwright cannot cancel the code still running, so
 * the Host refuses all further work and the process is retired with it (Sol5.6 R3).
 */
const REQUEST_DEADLINE_MS = 5 * 60_000;
/** MCP's default when a client sends no version header (spec 2025-06-18, "Protocol Version Header"). */
const DEFAULT_PROTOCOL_VERSION = '2025-03-26';

type Identity = { thread: string; workspace: string; binding: string };

interface BindingState extends Identity {
  view: ThreadView;
  server: McpServerLike;
  transport: LoopbackTransport;
  initialized: Promise<unknown>;
  lastActive: number;
}

const THREAD_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;

export class BrowserSessionHost {
  private readonly states = new Map<string, BindingState>();
  private readonly creating = new Map<string, Promise<BindingState>>();
  private readonly browsers = new Map<string, WorkspaceBrowser>();
  private readonly threadActivity = new Map<string, number>();
  private readonly now: () => number;
  /** Set when this process is about to exit; the API routes new work to the next one. */
  private refusing = false;

  constructor(private readonly deps: SessionHostDeps) {
    this.now = deps.now ?? Date.now;
  }

  get sessionCount(): number {
    return this.states.size;
  }

  get browserCount(): number {
    return [...this.browsers.values()].filter((browser) => browser.isRunning()).length;
  }

  async handle(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    if (!this.keyMatches(req.headers[BROWSER_KEY_HEADER])) return reply(res, 403, { error: 'browser_key_invalid' });
    if (this.refusing) return reply(res, 503, { error: 'browser_restarting' });
    const identity = {
      thread: single(req.headers[BROWSER_THREAD_HEADER]) ?? '',
      workspace: single(req.headers[BROWSER_WORKSPACE_HEADER]) ?? '',
      binding: single(req.headers[BROWSER_BINDING_HEADER]) ?? '',
    };
    if (!THREAD_PATTERN.test(identity.thread) || !identity.workspace.startsWith('/') || !identity.binding)
      return reply(res, 400, { error: 'browser_identity_missing' });
    if (req.method !== 'POST') return reply(res, 405, { error: 'method_not_allowed' });
    const messages = (Array.isArray(body) ? body : [body]) as JsonRpc[];
    if (!messages.length || messages.some((m) => !m || m.jsonrpc !== '2.0'))
      return reply(res, 400, { error: 'invalid_jsonrpc' });

    const initialize = messages.find((m) => m.method === 'initialize');
    const requested = (initialize?.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    const protocolVersion =
      typeof requested === 'string'
        ? requested
        : (single(req.headers['mcp-protocol-version']) ?? DEFAULT_PROTOCOL_VERSION);
    let state: BindingState;
    try {
      state = await this.stateFor(identity, protocolVersion);
    } catch (error) {
      return reply(res, 503, { error: (error as Error).message });
    }
    this.touch(state);
    const responses = (await Promise.all(messages.map((m) => this.dispatch(state, m)))).filter(Boolean);
    this.touch(state);
    if (!responses.length) {
      res.writeHead(202).end();
      return;
    }
    reply(res, 200, Array.isArray(body) ? responses : responses[0]);
  }

  /** Releases idle state, then idle threads' pages, then browsers nobody uses. */
  async reap(): Promise<void> {
    const now = this.now();
    for (const state of [...this.states.values()])
      if (now - state.lastActive > SESSION_IDLE_MS && state.transport.inFlight === 0) await this.release(state);
    const live = new Set([...this.states.values()].map((s) => threadKey(s)));
    for (const [key, last] of this.threadActivity) {
      if (live.has(key) || now - last <= THREAD_IDLE_MS) continue;
      const [workspace, thread] = key.split('\0') as [string, string];
      await this.browsers.get(workspace)?.closeThread(thread);
      this.threadActivity.delete(key);
    }
    for (const [workspace, browser] of this.browsers) {
      const inUse = [...this.states.values()].some((s) => s.workspace === workspace);
      if (!inUse && browser.isRunning() && (await browser.ownedPageCount()) === 0) await browser.close();
    }
  }

  /** Browsers first: a late call loses its pages at once instead of after every state is released. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.browsers.values()].map((browser) => browser.close()));
    for (const state of [...this.states.values()]) await this.release(state);
  }

  private async dispatch(state: BindingState, message: JsonRpc): Promise<JsonRpc | undefined> {
    if (message.method === 'initialize' && message.id !== undefined)
      return this.withDeadline(state, message, () =>
        state.initialized.then((result) => ({ jsonrpc: '2.0', id: message.id, result }) as JsonRpc),
      );
    if (message.method === undefined || message.method === 'notifications/initialized') return undefined;
    if (message.id === undefined) {
      state.transport.notify(message); // e.g. notifications/cancelled
      return undefined;
    }
    return this.withDeadline(state, message, () => state.initialized.then(() => state.transport.request(message)));
  }

  /** Every call, including waiting for initialize, settles within the deadline (Sol5.6 R2 P1-3). */
  private async withDeadline(state: BindingState, message: JsonRpc, run: () => Promise<JsonRpc>): Promise<JsonRpc> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => resolve('expired'), this.deps.requestDeadlineMs ?? REQUEST_DEADLINE_MS);
    });
    const outcome = await Promise.race([run(), expired]).finally(() => clearTimeout(timer));
    if (outcome !== 'expired') return outcome;
    state.transport.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: message.id } });
    this.poison();
    return {
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32001,
        message:
          'The browser call did not finish in time; the shared browser is restarting (open tabs are closed, logins are kept) and nothing was retried.',
      },
    } as JsonRpc;
  }

  /** Every request is refused from now on; called by the process owner before it exits. */
  stopServing(): void {
    this.refusing = true;
  }

  private poison(): void {
    if (this.refusing) return;
    this.refusing = true;
    // After the expired call's error has been written.
    setImmediate(() => this.deps.onPoisoned?.());
  }

  private stateFor(identity: Identity, protocolVersion: string): Promise<BindingState> {
    const existing = this.states.get(identity.binding);
    if (existing) {
      if (existing.thread !== identity.thread || existing.workspace !== identity.workspace)
        return Promise.reject(new Error('browser_binding_conflict'));
      return Promise.resolve(existing);
    }
    let pending = this.creating.get(identity.binding);
    if (!pending) {
      // Reserve the slot synchronously: in-flight creations count toward the limit (Sol5.6 R2 P1-2).
      if (this.states.size + this.creating.size >= MAX_STATES) {
        const idle = [...this.states.values()]
          .filter((s) => s.transport.inFlight === 0)
          .sort((a, b) => a.lastActive - b.lastActive)[0];
        if (!idle) return Promise.reject(new Error('browser_capacity_exhausted'));
        void this.release(idle); // removes it from `states` before its first await
      }
      pending = this.create(identity, protocolVersion).finally(() => this.creating.delete(identity.binding));
      this.creating.set(identity.binding, pending);
    }
    return pending;
  }

  private async create(identity: Identity, protocolVersion: string): Promise<BindingState> {
    const view = this.browserFor(identity.workspace).view(identity.thread);
    const server = await this.deps.createServer(this.sessionConfig(identity), () => view.prepare());
    const transport = new LoopbackTransport(identity.workspace);
    await server.connect(transport);
    const initialized = transport
      .request({
        jsonrpc: '2.0',
        id: 'cat-cafe-host-initialize',
        method: 'initialize',
        params: {
          protocolVersion,
          capabilities: { roots: { listChanged: false } },
          clientInfo: { name: 'cat-cafe-shared-browser', version: '1' },
        },
      })
      .then((response) => {
        if ('error' in response) throw new Error('browser_initialize_failed');
        transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
        return advertisedResult((response as { result?: Record<string, unknown> }).result);
      });
    const state: BindingState = { ...identity, view, server, transport, initialized, lastActive: this.now() };
    this.states.set(identity.binding, state);
    return state;
  }

  private sessionConfig(identity: Identity): Record<string, unknown> {
    return {
      browser: { browserName: 'chromium', isolated: false, launchOptions: { channel: 'chrome', headless: true } },
      // Upstream refuses browser_close when the context is shared between clients.
      sharedBrowserContext: true,
      outputDir: join(identity.workspace, '.playwright-mcp', identity.thread),
    };
  }

  private browserFor(workspace: string): WorkspaceBrowser {
    let browser = this.browsers.get(workspace);
    if (!browser) {
      browser = new WorkspaceBrowser(() => this.deps.launch(workspace));
      this.browsers.set(workspace, browser);
    }
    return browser;
  }

  private touch(state: BindingState): void {
    state.lastActive = this.now();
    this.threadActivity.set(threadKey(state), state.lastActive);
  }

  private async release(state: BindingState): Promise<void> {
    if (this.states.get(state.binding) !== state) return;
    this.states.delete(state.binding);
    // The thread's pages outlive this state by THREAD_IDLE_MS, counted from now.
    this.threadActivity.set(threadKey(state), this.now());
    await state.transport.close();
    await state.server.close().catch(() => {});
    state.view.dispose();
  }

  private keyMatches(value: string | string[] | undefined): boolean {
    const given = Buffer.from(single(value) ?? '');
    const expected = Buffer.from(this.deps.key);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}

/**
 * Server notifications have no channel back over the stateless edge, so the Host must not advertise
 * them. WebMCP dynamic tools (the only listChanged source) also stay off: Chrome is not launched with
 * `--enable-features=WebMCP`.
 */
function advertisedResult(result: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const capabilities = result?.capabilities as Record<string, Record<string, unknown>> | undefined;
  if (!result || !capabilities?.tools) return result;
  return { ...result, capabilities: { ...capabilities, tools: { ...capabilities.tools, listChanged: false } } };
}

const threadKey = (identity: { workspace: string; thread: string }) => `${identity.workspace}\0${identity.thread}`;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

function reply(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
}
