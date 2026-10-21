import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { PiAcpSession } from './pi-acp-session.js';
import { type PiRecord, record } from './pi-rpc-process.js';

/** A small ACP adapter around an already installed Pi. It never installs a package or logs credentials. */
export class PiAcpBridge {
  private readonly sessions = new Map<string, PiAcpSession>();
  private closing?: Promise<void>;
  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly write: (value: PiRecord) => void,
  ) {}

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
            agentInfo: { name: 'clowder-pi-bridge', title: 'Pi', version: '1.0.0' },
            agentCapabilities: {
              loadSession: false,
              sessionCapabilities: { close: {} },
              promptCapabilities: {},
              mcpCapabilities: { http: false, sse: false },
            },
          });
          return;
        case 'session/new':
          respond(await this.newSession(params));
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
          error: { code: -32603, message: error instanceof Error ? error.message : 'Pi bridge request failed' },
        });
    }
  }

  private async newSession(params: PiRecord): Promise<PiRecord> {
    if (typeof params.cwd !== 'string' || !isAbsolute(params.cwd))
      throw new Error('Pi requires an absolute working directory');
    if (params.mode || params.toolExecutionPolicy || record(params._meta).toolExecutionPolicy)
      throw new Error('The Pi bridge cannot enforce this restricted execution policy');
    const session = new PiAcpSession(this.command, this.args, params.cwd, params.mcpServers, (update) =>
      this.write({ jsonrpc: '2.0', method: 'session/update', params: update }),
    );
    this.sessions.set(session.id, session);
    try {
      return await session.describe();
    } catch (error) {
      this.sessions.delete(session.id);
      await session.close();
      throw error;
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
  const bridge = new PiAcpBridge(command, [], (value) => process.stdout.write(`${JSON.stringify(value)}\n`));
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
