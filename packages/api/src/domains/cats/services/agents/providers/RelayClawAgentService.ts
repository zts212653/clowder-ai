/**
 * RelayClaw Agent Service
 *
 * Implements AgentService for relay-claw's AgentWebSocketServer.
 * Maintains a single persistent WebSocket connection (P1: relay-claw
 * tracks only one _current_ws). Requests are multiplexed via request_id.
 *
 * Wire protocol: jiuwenclaw/schema/agent.py
 * - Send: AgentRequest JSON with is_stream=true
 * - Recv: AgentResponseChunk JSON per event, is_complete=true marks end
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatId, RelayClawAgentConfig, RelayClawWsFrame } from '@cat-cafe/shared';
import { createCatId } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type { AgentMessage, AgentService, AgentServiceOptions } from '../../types.js';
import { tcpProbe } from '../../../../../utils/tcp-probe.js';
import { resolveJiuwenClawAppDir, resolveJiuwenClawPythonBin } from '../../../../../utils/jiuwenclaw-paths.js';
import { appendLocalImagePathHints } from './image-cli-bridge.js';
import { extractImagePaths } from './image-paths.js';
import { transformRelayClawChunk } from './relayclaw-event-transform.js';

export interface RelayClawAgentServiceOptions {
  catId?: CatId;
  config: RelayClawAgentConfig;
}

function agentMsg(type: AgentMessage['type'], catId: CatId, content?: string): AgentMessage {
  return { type, catId, content, timestamp: Date.now() };
}

const log = createModuleLogger('relayclaw-agent');
const CAT_CAFE_MCP_CALLBACK_ENV_KEYS = [
  'CAT_CAFE_API_URL',
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CAT_CAFE_USER_ID',
  'CAT_CAFE_CAT_ID',
  'CAT_CAFE_SIGNAL_USER',
] as const;

function resolveCatCafeMcpServer(
  workingDirectory?: string,
): { serverPath: string; repoRoot: string } | null {
  const candidateRoots: string[] = [];
  if (workingDirectory) candidateRoots.push(workingDirectory);
  candidateRoots.push(process.cwd());

  const fileDir = dirname(fileURLToPath(import.meta.url));
  candidateRoots.push(resolve(fileDir, '../../../../../../../..'));

  for (const root of candidateRoots) {
    const repoRoot = resolve(root);
    const serverPath = resolve(repoRoot, 'packages/mcp-server/dist/index.js');
    if (existsSync(serverPath)) {
      return { serverPath, repoRoot };
    }
  }

  return null;
}

function buildRelayClawFilesPayload(
  contentBlocks: AgentServiceOptions['contentBlocks'],
  uploadDir?: string,
): Record<string, unknown> | undefined {
  const imagePaths = extractImagePaths(contentBlocks, uploadDir);
  if (imagePaths.length === 0) return undefined;
  return {
    uploaded: imagePaths.map((path, index) => ({
      type: 'image',
      name: basename(path) || `image-${index + 1}`,
      path,
    })),
  };
}

function buildCatCafeMcpRequestConfig(options?: AgentServiceOptions): Record<string, unknown> | undefined {
  const callbackEnv = options?.callbackEnv ?? {};
  const resolved = resolveCatCafeMcpServer(options?.workingDirectory);
  if (!resolved) return undefined;

  const env = Object.fromEntries(
    CAT_CAFE_MCP_CALLBACK_ENV_KEYS.map((key) => [key, callbackEnv[key]]).filter(([, value]) => Boolean(value)),
  ) as Record<string, string>;

  return {
    command: 'node',
    args: [resolved.serverPath],
    cwd: resolved.repoRoot,
    env,
  };
}

/**
 * Lightweight async queue: producer puts frames, consumer iterates.
 * Sentinel `null` signals end-of-stream.
 */
class FrameQueue {
  private queue: (RelayClawWsFrame | null)[] = [];
  private waitResolve: ((value: RelayClawWsFrame | null) => void) | null = null;

  put(frame: RelayClawWsFrame | null): void {
    if (this.waitResolve) {
      const resolve = this.waitResolve;
      this.waitResolve = null;
      resolve(frame);
    } else {
      this.queue.push(frame);
    }
  }

  take(): Promise<RelayClawWsFrame | null> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift()!);
    }
    return new Promise<RelayClawWsFrame | null>((resolve) => {
      this.waitResolve = resolve;
    });
  }

  /** Drain all pending waiters on abort */
  abort(): void {
    this.put(null);
  }
}

export class RelayClawAgentService implements AgentService {
  private readonly catId: CatId;
  private readonly config: RelayClawAgentConfig;

  // Persistent connection state
  private ws: WebSocket | null = null;
  private serverReady = false;
  private connectPromise: Promise<void> | null = null;
  /** Per-request queues keyed by request_id */
  private readonly requestQueues = new Map<string, FrameQueue>();
  private sidecar: ChildProcess | null = null;
  private sidecarBootPromise: Promise<void> | null = null;
  private sidecarRuntimeHash: string | null = null;
  private resolvedUrl: string | null = null;
  private recentLogs = '';

  constructor(options: RelayClawAgentServiceOptions) {
    this.catId = options.catId ?? createCatId('relayclaw-agent');
    this.config = options.config;
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const catId = this.catId;
    const timeoutMs = this.config.timeoutMs ?? 180_000;

    // Combine timeout + caller abort
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (options?.signal) signals.push(options.signal);
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    yield agentMsg('session_init', catId);

    try {
      await this.ensureConnected(signal, options);
    } catch (err) {
      yield {
        type: 'error',
        catId,
        error: `jiuwenClaw connection failed: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      };
      return;
    }

    const requestId = randomUUID();
    const channelId = this.config.channelId ?? 'catcafe';
    // P2: session_id format must start with channel prefix (relay-claw parses it)
    const sessionId = `${channelId}_${Date.now().toString(16)}_${randomUUID().slice(0, 12)}`;

    const queue = new FrameQueue();
    this.requestQueues.set(requestId, queue);

    // Register abort handler to drain the queue
    const onAbort = () => queue.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      // Send streaming chat request
      const requestFiles = buildRelayClawFilesPayload(options?.contentBlocks, options?.uploadDir);
      const promptWithImageHints = appendLocalImagePathHints(prompt, extractImagePaths(options?.contentBlocks, options?.uploadDir));
      const catCafeMcp = buildCatCafeMcpRequestConfig(options);
      const request = {
        request_id: requestId,
        channel_id: channelId,
        session_id: sessionId,
        req_method: 'chat.send',
        params: {
          query: promptWithImageHints,
          mode: 'agent',
          ...(requestFiles ? { files: requestFiles } : {}),
          ...(options?.workingDirectory ? { project_dir: options.workingDirectory } : {}),
          ...(catCafeMcp ? { cat_cafe_mcp: catCafeMcp } : {}),
        },
        is_stream: true,
        timestamp: Date.now() / 1000,
      };

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        yield agentMsg('error', catId, 'jiuwenClaw WebSocket not connected');
        return;
      }
      this.ws.send(JSON.stringify(request));

      // Consume response chunks
      let sawDone = false;
      let emittedText = false;
      while (!signal.aborted) {
        const frame = await queue.take();
        if (frame === null) break; // End of stream or abort

        // Check frame-level is_complete (final sentinel)
        const isComplete = frame.is_complete === true || frame.payload?.is_complete === true;
        const payload = frame.payload;

        const msg = transformRelayClawChunk(frame, catId);
        if (msg) {
          yield msg;
          if (msg.type === 'text' && typeof msg.content === 'string' && msg.content.length > 0) {
            emittedText = true;
          }
          if (msg.type === 'error') {
            sawDone = true;
            break;
          }
        } else if (
          !emittedText &&
          payload?.event_type === 'chat.final' &&
          typeof payload.content === 'string' &&
          payload.content.length > 0
        ) {
          emittedText = true;
          yield agentMsg('text', catId, payload.content);
        }

        if (isComplete) break;
      }

      if (!sawDone) {
        yield agentMsg('done', catId);
      }
    } catch (err) {
      const isCallerAbort = options?.signal?.aborted === true;
      if (isCallerAbort) {
        yield agentMsg('done', catId);
      } else {
        const errMsg = err instanceof Error ? err.message : String(err);
        yield { type: 'error', catId, error: `jiuwenClaw error: ${errMsg}`, timestamp: Date.now() };
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.requestQueues.delete(requestId);
    }
  }

  // ── Connection management ──────────────────────────────────

  private async ensureConnected(signal?: AbortSignal, options?: AgentServiceOptions): Promise<void> {
    if (this.config.autoStart) {
      await this.ensureSidecar(options, signal);
    }

    if (this.ws?.readyState === WebSocket.OPEN && this.serverReady) return;

    // If already connecting, wait for that
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = this.connect(signal);
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private connect(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Aborted before connect'));
        return;
      }

      const url = this.resolveUrl();
      const ws = new WebSocket(url);
      this.ws = ws;
      this.serverReady = false;

      const onAbort = () => {
        ws.close();
        reject(new Error('Connection aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const cleanup = () => signal?.removeEventListener('abort', onAbort);

      ws.addEventListener('open', () => {
        // Wait for connection.ack before resolving
      });

      ws.addEventListener('message', (event: MessageEvent) => {
        const data = typeof event.data === 'string' ? event.data : String(event.data);
        let frame: RelayClawWsFrame;
        try {
          frame = JSON.parse(data) as RelayClawWsFrame;
        } catch {
          return; // Ignore unparseable frames
        }

        // Handle connection.ack
        if (frame.type === 'event' && frame.event === 'connection.ack') {
          this.serverReady = true;
          cleanup();
          resolve();
          return;
        }

        // Route by request_id
        const rid = frame.request_id;
        if (rid) {
          const queue = this.requestQueues.get(rid);
          if (queue) {
            queue.put(frame);
            // If this is the final chunk, signal end
            if (frame.is_complete === true || frame.payload?.is_complete === true) {
              queue.put(null);
            }
          }
          return;
        }

        // Push events (no request_id) — agent-initiated, currently ignored
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
        // Drain all pending request queues
        for (const queue of this.requestQueues.values()) {
          queue.abort();
        }
        cleanup();
        if (!this.serverReady) {
          reject(new Error('WebSocket closed before ready'));
        }
      });
    });
  }

  private resolveUrl(): string {
    const url = this.resolvedUrl ?? this.config.url;
    if (!url) {
      throw new Error('jiuwenClaw WebSocket URL is not configured');
    }
    return url;
  }

  private async ensureSidecar(options?: AgentServiceOptions, signal?: AbortSignal): Promise<void> {
    const runtime = this.buildSidecarRuntime(options);
    const runtimeHash = createHash('sha256').update(JSON.stringify(runtime.signature)).digest('hex');
    const childAlive = this.sidecar?.killed === false && this.sidecar.exitCode === null;

    if (childAlive && this.sidecarRuntimeHash === runtimeHash && this.resolvedUrl) {
      const parsed = new URL(this.resolvedUrl);
      const port = Number.parseInt(parsed.port, 10);
      if (port > 0 && (await tcpProbe(parsed.hostname, port, 400))) {
        return;
      }
    }

    if (this.sidecar && this.sidecarRuntimeHash !== runtimeHash) {
      this.stopSidecar();
    }

    if (this.sidecarBootPromise) {
      await this.sidecarBootPromise;
      return;
    }

    this.sidecarBootPromise = this.startSidecar(runtime, signal);
    try {
      await this.sidecarBootPromise;
    } finally {
      this.sidecarBootPromise = null;
    }
  }

  private buildSidecarRuntime(options?: AgentServiceOptions): {
    pythonBin: string;
    appDir: string;
    homeDir: string;
    agentPort: number;
    webPort: number;
    env: Record<string, string>;
    signature: Record<string, string | number>;
  } {
    const callbackEnv = options?.callbackEnv ?? {};
    const appDir = resolveJiuwenClawAppDir(this.config.appDir);
    const pythonBin = resolveJiuwenClawPythonBin(this.config.pythonBin, appDir);
    const homeDir = this.config.homeDir?.trim() || join(process.cwd(), '.cat-cafe', 'relayclaw', this.catId as string);
    const apiKey =
      callbackEnv.API_KEY ||
      callbackEnv.OPENAI_API_KEY ||
      callbackEnv.OPENROUTER_API_KEY ||
      '';
    const apiBase = callbackEnv.API_BASE || callbackEnv.OPENAI_BASE_URL || callbackEnv.OPENAI_API_BASE || '';
    const provider = apiBase.includes('openrouter.ai') ? 'OpenRouter' : 'OpenAI';
    const modelName = this.config.modelName?.trim() || 'gpt-5.4';
    const projectDir = options?.workingDirectory?.trim() || '';
    const catCafeMcp = resolveCatCafeMcpServer(options?.workingDirectory);
    const catCafeMcpEnv = Object.fromEntries(
      CAT_CAFE_MCP_CALLBACK_ENV_KEYS.map((key) => [key, callbackEnv[key]]).filter(([, value]) => Boolean(value)),
    ) as Record<string, string>;
    return {
      pythonBin,
      appDir,
      homeDir,
      agentPort: this.config.agentPort ?? 0,
      webPort: this.config.webPort ?? 0,
      env: {
        HOME: homeDir,
        PYTHONUNBUFFERED: '1',
        WEB_HOST: '127.0.0.1',
        API_KEY: apiKey,
        API_BASE: apiBase,
        MODEL_NAME: modelName,
        MODEL_PROVIDER: provider,
        JIUWENCLAW_AGENT_ROOT: join(homeDir, 'agent'),
        ...(projectDir ? { JIUWENCLAW_PROJECT_DIR: projectDir } : {}),
        ...(catCafeMcp
          ? {
              CAT_CAFE_MCP_SERVER_PATH: catCafeMcp.serverPath,
              CAT_CAFE_MCP_COMMAND: 'node',
              CAT_CAFE_MCP_ARGS_JSON: JSON.stringify([catCafeMcp.serverPath]),
              CAT_CAFE_MCP_CWD: catCafeMcp.repoRoot,
            }
          : {}),
        ...catCafeMcpEnv,
      },
      signature: {
        pythonBin,
        appDir,
        homeDir,
        apiBase,
        modelName,
        provider,
        projectDir,
        catCafeMcpPath: catCafeMcp?.serverPath ?? '',
        keyHash: apiKey ? createHash('sha256').update(apiKey).digest('hex') : '',
      },
    };
  }

  private async startSidecar(
    runtime: ReturnType<RelayClawAgentService['buildSidecarRuntime']>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!runtime.env.API_KEY || !runtime.env.API_BASE) {
      throw new Error('jiuwenClaw requires a bound openai-compatible API key profile');
    }

    mkdirSync(runtime.homeDir, { recursive: true });
    const agentPort = runtime.agentPort || (await findOpenPort());
    const webPort = runtime.webPort || (await findOpenPort());
    this.resolvedUrl = `ws://127.0.0.1:${agentPort}`;
    this.recentLogs = '';
    this.serverReady = false;
    this.ws?.close();
    this.ws = null;

    const child = spawn(runtime.pythonBin, ['-m', 'jiuwenclaw.app'], {
      cwd: runtime.appDir,
      env: {
        ...process.env,
        ...runtime.env,
        AGENT_PORT: String(agentPort),
        WEB_PORT: String(webPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.sidecar = child;
    this.sidecarRuntimeHash = createHash('sha256').update(JSON.stringify(runtime.signature)).digest('hex');

    const pushLog = (chunk: Buffer) => {
      this.recentLogs = `${this.recentLogs}${chunk.toString('utf-8')}`.slice(-8000);
    };
    child.stdout.on('data', pushLog);
    child.stderr.on('data', pushLog);
    child.once('exit', (code, exitSignal) => {
      log.warn({ catId: this.catId, code, exitSignal }, 'relayclaw sidecar exited');
      this.sidecar = null;
      this.sidecarRuntimeHash = null;
      this.serverReady = false;
      this.ws = null;
      for (const queue of this.requestQueues.values()) {
        queue.abort();
      }
    });

    if (signal?.aborted) {
      this.stopSidecar();
      throw new Error('jiuwenClaw sidecar startup aborted');
    }

    const timeoutAt = Date.now() + (this.config.startupTimeoutMs ?? 45_000);
    while (Date.now() < timeoutAt) {
      if (signal?.aborted) {
        this.stopSidecar();
        throw new Error('jiuwenClaw sidecar startup aborted');
      }
      if (!this.sidecar || this.sidecar.exitCode !== null) {
        throw new Error(`jiuwenClaw sidecar exited during startup${this.recentLogs ? `: ${this.summarizeLogs()}` : ''}`);
      }
      if (await tcpProbe('127.0.0.1', agentPort, 400) && this.isSidecarReady()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    this.stopSidecar();
    throw new Error(`jiuwenClaw sidecar did not become ready in time${this.recentLogs ? `: ${this.summarizeLogs()}` : ''}`);
  }

  private summarizeLogs(): string {
    return this.recentLogs
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-6)
      .join(' | ');
  }

  private isSidecarReady(): boolean {
    return (
      this.recentLogs.includes('[JiuWenClaw] 初始化完成') ||
      this.recentLogs.includes('JiuWenClaw] 初始化完成') ||
      this.recentLogs.includes('WebChannel 已启动')
    );
  }

  private stopSidecar(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore close errors
      }
    }
    this.ws = null;
    this.serverReady = false;
    if (this.sidecar && this.sidecar.exitCode === null) {
      this.sidecar.kill('SIGTERM');
    }
    this.sidecar = null;
    this.sidecarRuntimeHash = null;
  }
}

async function findOpenPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate relayclaw port')));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}
