import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { resolveCatCafeDataRoot } from '../../../../../../utils/cli-process-ownership.js';
import { PiAcpSession } from './pi-acp-session.js';
import { encodePiAcpRecord, PI_BRIDGE_NAME, PI_SESSION_BINDING_ERROR } from './pi-bridge-contract.js';
import { piErrorExcerpt } from './pi-rpc-diagnostics.js';
import { type PiRecord, record } from './pi-rpc-process.js';
import { type PiSessionSlot, type PiSessionStorage, PiSessionStore, piDigest } from './pi-session-store.js';

/** A small ACP adapter around an already installed Pi. It never installs a package or logs credentials. */
export class PiAcpBridge {
  private readonly sessions = new Map<string, PiAcpSession>();
  private closing?: Promise<void>;
  private readonly opening = new Map<string, Promise<PiRecord>>();
  private readonly store: PiSessionStore;
  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly write: (value: PiRecord) => void,
    storage?: PiSessionStorage,
  ) {
    this.store = new PiSessionStore(
      storage ?? {
        root: resolveCatCafeDataRoot(),
        scope: piDigest(JSON.stringify([command, args, process.env.PI_CODING_AGENT_DIR ?? 'native-default'])),
      },
    );
  }

  async handle(value: unknown): Promise<void> {
    const request = record(value),
      params = record(request.params);
    const respond = (result: PiRecord) => {
      if (request.id !== undefined) this.write({ jsonrpc: '2.0', id: request.id, result });
    };
    try {
      if (this.closing) throw new Error('Pi bridge is shutting down');
      switch (request.method) {
        case 'initialize':
          respond({
            protocolVersion: 1,
            authMethods: [],
            agentInfo: { name: PI_BRIDGE_NAME, title: 'Pi', version: '1.1.0' },
            agentCapabilities: {
              loadSession: true,
              sessionCapabilities: { close: {} },
              promptCapabilities: {},
              mcpCapabilities: { http: false, sse: false },
            },
          });
          return;
        case 'session/new':
          respond(await this.newSession(params));
          return;
        case 'session/load':
          respond(await this.loadSession(params));
          return;
        case 'session/prompt':
          respond(await this.session(params.sessionId).prompt(params.prompt));
          return;
        case 'session/set_config_option':
          respond(await this.session(params.sessionId).setOption(params.configId, params.value));
          return;
        case 'session/cancel':
          await this.session(params.sessionId).cancel();
          respond({});
          return;
        case 'session/close':
          await this.session(params.sessionId).close();
          this.sessions.delete(String(params.sessionId));
          respond({});
          return;
        default:
          if (request.id !== undefined)
            this.write({
              jsonrpc: '2.0',
              id: request.id,
              error: { code: -32601, message: 'Pi bridge method is not supported' },
            });
      }
    } catch (error) {
      if (request.id !== undefined)
        this.write({
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: request.method === 'session/load' ? PI_SESSION_BINDING_ERROR : -32603,
            message: error instanceof Error ? piErrorExcerpt(error.message, 1500) : 'Pi bridge request failed',
          },
        });
    }
  }

  private async newSession(params: PiRecord): Promise<PiRecord> {
    this.validateSession(params);
    return this.startSession(this.store.create(params.cwd, params.mcpServers), params.mcpServers);
  }

  private validateSession(params: PiRecord): void {
    if (typeof params.cwd !== 'string' || !isAbsolute(params.cwd))
      throw new Error('Pi requires an absolute working directory');
    if (params.mode || params.toolExecutionPolicy || record(params._meta).toolExecutionPolicy)
      throw new Error('The Pi bridge cannot enforce this restricted execution policy');
  }
  private async loadSession(params: PiRecord): Promise<PiRecord> {
    this.validateSession(params);
    const active = typeof params.sessionId === 'string' ? this.sessions.get(params.sessionId) : undefined;
    if (active?.available) {
      this.store.assertBinding(active.slot, params.cwd, params.mcpServers);
      return this.opening.get(active.id) ?? active.describe();
    }
    if (active) {
      await active.close();
      this.sessions.delete(active.id);
    }
    return this.startSession(this.store.load(params.sessionId, params.cwd, params.mcpServers), params.mcpServers);
  }
  private async startSession(slot: PiSessionSlot, servers: unknown): Promise<PiRecord> {
    const pending = this.opening.get(slot.id);
    if (pending) return pending;
    const session = new PiAcpSession(
      this.command,
      this.args,
      slot.cwd,
      servers,
      (update) => this.write({ jsonrpc: '2.0', method: 'session/update', params: update }),
      slot,
    );
    this.sessions.set(session.id, session);
    const ready = session.describe();
    this.opening.set(slot.id, ready);
    try {
      const result = await ready;
      if (this.closing) throw new Error('Pi bridge is shutting down');
      return result;
    } catch (error) {
      this.sessions.delete(session.id);
      await session.close();
      throw error;
    } finally {
      this.opening.delete(slot.id);
    }
  }

  private session(id: unknown): PiAcpSession {
    const session = typeof id === 'string' ? this.sessions.get(id) : undefined;
    if (!session) throw new Error('Pi session is unavailable; start a new session');
    return session;
  }

  close(): Promise<void> {
    this.closing ??= Promise.allSettled([...this.sessions.values()].map((session) => session.close())).then(() => {
      this.sessions.clear();
    });
    return this.closing;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2),
    commandIndex = args.indexOf('--pi-command');
  const command = args[commandIndex + 1];
  if (commandIndex === -1 || !command) throw new Error('An installed Pi command is required');
  const rootIndex = args.indexOf('--session-root'),
    scopeIndex = args.indexOf('--session-scope');
  if ((rootIndex === -1) !== (scopeIndex === -1))
    throw new Error('Pi storage root and scope must be provided together');
  const storage = rootIndex === -1 ? undefined : { root: args[rootIndex + 1] ?? '', scope: args[scopeIndex + 1] ?? '' };
  const bridge = new PiAcpBridge(command, [], (value) => process.stdout.write(encodePiAcpRecord(value)), storage);
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  process.stdin.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    if (buffer.length > 4_000_000) {
      process.stdin.destroy();
      void bridge.close();
      return;
    }
    for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        void bridge.handle(JSON.parse(line));
      } catch {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC input' } })}\n`,
        );
      }
    }
  });
  process.stdin.once('end', () => {
    void bridge.close();
  });
  process.stdin.once('close', () => {
    void bridge.close();
  });
  process.stdout.once('error', () => {
    void bridge.close().finally(() => {
      process.exitCode = 1;
    });
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void bridge.close().finally(() => process.exit(0));
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(() => {
    process.stderr.write('Pi bridge startup failed\n');
    process.exitCode = 1;
  });
