/**
 * AcpHttpStreamClient — HTTP streaming transport for ACP agent processes.
 *
 * F161 Phase C: Spawn a child process that starts an HTTP ACP server (e.g.
 * `opencode acp --port 0`), discover the port from stdout, then communicate
 * via HTTP POST with NDJSON streaming responses.
 *
 * Same public API as AcpClient (stdio) so AcpProcessPool / AcpAgentService
 * work with either transport transparently.
 *
 * Key differences from stdio:
 *   - Process stdout is scanned for port discovery, not used for protocol messages
 *   - JSON-RPC requests go via HTTP POST to http://localhost:<port>/
 *   - Streaming responses (session/prompt) return NDJSON lines
 *   - session/cancel is a fire-and-forget HTTP POST
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { request as nodeHttpRequest } from 'node:http';
import { dirname, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';

import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import { resolveCliCommandOrBare } from '../../../../../../utils/cli-resolve.js';
import { resolveWindowsSpawnPlan } from '../../../../../../utils/cli-spawn-win.js';
import {
  type AcpCapacitySignal,
  type AcpClientConfig,
  AcpProtocolError,
  AcpStreamIdleError,
  AcpTimeoutError,
  buildAcpSpawnLogFields,
} from './AcpClient.js';
import type {
  AcpAgentRequest,
  AcpInitializeResult,
  AcpMcpServer,
  AcpNewSessionResult,
  AcpNotification,
  AcpPermissionRequest,
  AcpPromptResult,
  AcpResponse,
  AcpSessionUpdate,
  AcpStopReason,
} from './types.js';
import { ACP_METHODS } from './types.js';

const log = createModuleLogger('acp-http-client');

const IS_WINDOWS = process.platform === 'win32';
const KILL_GRACE_MS = 3_000;
const PORT_DISCOVERY_TIMEOUT_MS = 30_000;

/** Regex to discover the HTTP port from process stdout.
 *  Matches common patterns: "Listening on port 12345", "port: 12345", '{"port":12345}' */
const PORT_RE = /(?:port[:\s]+|"port"\s*:\s*)(\d{4,5})/i;

const CAPACITY_RE = /MODEL_CAPACITY_EXHAUSTED|No capacity available|status 429.*Retrying/i;

// ─── HTTP streaming client config ────────────────────────────

export interface AcpHttpStreamClientConfig extends AcpClientConfig {
  /** Port discovery timeout (ms). Default 30s. */
  portDiscoveryTimeoutMs?: number;
}

interface AgentResponseOptions {
  responseTimeoutMs?: number;
  signal?: AbortSignal;
}

// ─── Client ──────────────────────────────────────────────────

export class AcpHttpStreamClient {
  private child: ChildProcess | null = null;
  private closed = false;
  private exited = false;
  private port: number | null = null;
  private baseUrl = '';
  private initResult: AcpInitializeResult | null = null;
  private readonly capacityListeners = new Set<(signal: AcpCapacitySignal) => void>();
  private _recentCapacitySignal: AcpCapacitySignal | null = null;

  constructor(private readonly config: AcpHttpStreamClientConfig) {}

  // ── Lifecycle ────────────────────────────────────────────────

  async initialize(): Promise<AcpInitializeResult> {
    // Phase 1: spawn the process
    const doSpawn = this.config.spawnFn ?? nodeSpawn;
    let command = resolveCliCommandOrBare(this.config.command);
    let args = [...this.config.args];
    const childEnv = { ...process.env, ...this.config.env };
    if (!IS_WINDOWS && isAbsolute(command)) {
      const binDir = dirname(command);
      childEnv.PATH = childEnv.PATH ? `${binDir}:${childEnv.PATH}` : binDir;
    }
    // #712: Re-create bootstrap CWD if cleaned up by OS temp-dir rotation or agent exit.
    // Skip when a test spawnFn is injected — the directory may be a fake path
    // (e.g. '/my/project') that can't be created on CI runners.
    if (!this.config.spawnFn) {
      mkdirSync(this.config.cwd, { recursive: true, mode: 0o700 });
    }

    const spawnOpts: SpawnOptions & { stdio: ['pipe', 'pipe', 'pipe'] } = {
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    };
    if (IS_WINDOWS && !this.config.spawnFn) {
      const spawnPlan = resolveWindowsSpawnPlan(command, args);
      command = spawnPlan.command;
      args = spawnPlan.args;
      if (spawnPlan.shell !== undefined) spawnOpts.shell = spawnPlan.shell;
    }

    this.child = doSpawn(command, args, spawnOpts) as ChildProcess;

    // Stderr: capacity detection (shared with stdio client)
    this.child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      log.warn({ pid: this.child?.pid }, '[acp-http stderr] %s', text);
      if (CAPACITY_RE.test(text)) {
        const signal: AcpCapacitySignal = { message: text.slice(0, 300), timestamp: Date.now() };
        this._recentCapacitySignal = signal;
        for (const fn of this.capacityListeners) fn(signal);
      }
    });

    this.child.on('error', (err) => {
      log.error('ACP HTTP process error: %s', err.message);
      this.exited = true;
    });

    this.child.on('exit', (code, signal) => {
      log.info('ACP HTTP process exited: code=%s signal=%s', code, signal);
      this.exited = true;
    });

    log.info(
      buildAcpSpawnLogFields({ command, args, cwd: this.config.cwd, pid: this.child.pid, env: this.config.env }),
      'ACP HTTP: process spawned, discovering port from stdout',
    );

    // Phase 2: discover port from stdout
    this.port = await this.discoverPort();
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    log.info({ port: this.port, pid: this.child.pid }, 'ACP HTTP: port discovered');

    // Phase 3: send initialize via HTTP
    const resp = await this.httpRequest(ACP_METHODS.initialize, { protocolVersion: 1 });
    this.initResult = resp.result as unknown as AcpInitializeResult;
    log.info(
      {
        agentInfo: this.initResult.agentInfo,
        loadSession: this.initResult.agentCapabilities?.loadSession,
        pid: this.child?.pid,
        port: this.port,
      },
      'ACP HTTP: agent ready',
    );
    return this.initResult;
  }

  async newSession(cwd?: string, mcpServers: AcpMcpServer[] = []): Promise<AcpNewSessionResult> {
    const compatible = this.filterMcpByCapabilities(mcpServers);
    const effectiveCwd = cwd ?? this.config.cwd;
    log.info(
      { cwd: effectiveCwd, mcpServerCount: compatible.length, pid: this.child?.pid, port: this.port },
      'ACP HTTP session/new',
    );
    const t0 = Date.now();
    const resp = await this.httpRequest(ACP_METHODS.sessionNew, { cwd: effectiveCwd, mcpServers: compatible });
    log.info({ durationMs: Date.now() - t0, hasResult: !!resp.result }, 'ACP HTTP session/new: response');
    return resp.result as unknown as AcpNewSessionResult;
  }

  async loadSession(sessionId: string, cwd?: string, mcpServers: AcpMcpServer[] = []): Promise<AcpNewSessionResult> {
    const compatible = this.filterMcpByCapabilities(mcpServers);
    const effectiveCwd = cwd ?? this.config.cwd;
    log.info(
      { sessionId, cwd: effectiveCwd, mcpServerCount: compatible.length, pid: this.child?.pid, port: this.port },
      'ACP HTTP session/load',
    );
    const t0 = Date.now();
    const resp = await this.httpRequest(ACP_METHODS.sessionLoad, {
      sessionId,
      cwd: effectiveCwd,
      mcpServers: compatible,
    });
    log.info({ sessionId, durationMs: Date.now() - t0, hasResult: !!resp.result }, 'ACP HTTP session/load: response');
    return resp.result as unknown as AcpNewSessionResult;
  }

  async setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    if (!configId.trim() || !value.trim()) return;
    await this.httpRequest(ACP_METHODS.sessionSetConfigOption, {
      sessionId,
      configId: configId.trim(),
      value: value.trim(),
    });
  }

  /**
   * Stream prompt events via HTTP streaming response.
   * Same yield semantics as AcpClient.promptStream.
   */
  async *promptStream(
    sessionId: string,
    text: string,
    options?: { timeoutMs?: number; idleWarningMs?: number; idleStallMs?: number },
  ): AsyncGenerator<AcpSessionUpdate, AcpStopReason> {
    const timeoutMs = options?.timeoutMs ?? 900_000;
    const idleWarningMs = options?.idleWarningMs ?? 20_000;
    const idleStallMs = options?.idleStallMs ?? 90_000;

    const id = randomUUID();
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: ACP_METHODS.sessionPrompt,
      id,
      params: { sessionId, prompt: [{ type: 'text', text }] },
    });
    const controller = new AbortController();

    let eventCount = 0;
    let lastEventAt = 0;
    let idleWarningFired = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let budgetTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingTool = false;
    let stopReason: AcpStopReason = 'end_turn';
    let promptError: Error | null = null;
    let done = false;
    let finalResponseReceived = false;

    const queue: AcpSessionUpdate[] = [];
    let waitResolve: (() => void) | null = null;

    /** Wake the consumer loop if it's waiting. Extracted to avoid TS narrowing issues with waitResolve. */
    const wakeConsumer = () => {
      if (waitResolve) {
        const resolve = waitResolve;
        waitResolve = null;
        resolve();
      }
    };

    const resetBudget = () => {
      if (budgetTimer) clearTimeout(budgetTimer);
      if (done) return;
      budgetTimer = setTimeout(() => {
        if (done) return;
        log.error({ sessionId, eventCount, timeoutMs }, 'HTTP turn budget exceeded');
        this.cancelSession(sessionId);
        controller.abort();
        promptError = new AcpTimeoutError('session/prompt', timeoutMs);
        done = true;
        wakeConsumer();
      }, timeoutMs);
    };

    const injectSynthetic = (update: Record<string, unknown>) => {
      queue.push({ sessionId, update } as AcpSessionUpdate);
      wakeConsumer();
    };

    const capacityInjector = (signal: AcpCapacitySignal) => {
      injectSynthetic({
        sessionUpdate: 'provider_capacity_signal',
        message: signal.message,
        timestamp: signal.timestamp,
      });
    };

    const failPrompt = (err: unknown) => {
      promptError = err instanceof Error ? err : new Error(String(err));
      done = true;
      wakeConsumer();
      controller.abort();
    };

    const enqueueSessionUpdate = (params: AcpSessionUpdate | Record<string, unknown>) => {
      if (params.sessionId !== sessionId) return;

      queue.push(params as AcpSessionUpdate);
      eventCount++;
      lastEventAt = Date.now();
      idleWarningFired = false;

      const inner = (params.update ?? params) as Record<string, unknown>;
      const updateType = inner.sessionUpdate as string | undefined;
      if (updateType === 'tool_call' || updateType === 'permission_pending') {
        pendingTool = true;
      } else if (pendingTool && updateType !== 'tool_call_update' && updateType !== 'agent_thought_chunk') {
        pendingTool = false;
      }
      scheduleIdleCheck();
      resetBudget();
      wakeConsumer();
    };

    const handleAgentRequestFromStream = async (msg: Record<string, unknown>, msgId: string | undefined) => {
      const requestId = msgId ?? `synth-perm-${Date.now()}`;
      const req = { ...msg, id: requestId } as unknown as AcpAgentRequest;
      if (req.method === ACP_METHODS.requestPermission) {
        const params = req.params as Record<string, unknown>;
        enqueueSessionUpdate({ sessionId: params.sessionId, sessionUpdate: 'permission_pending' });
      }
      await this.handleAgentRequest(req, { responseTimeoutMs: timeoutMs, signal: controller.signal });
    };

    const isAgentRequest = (method: string | undefined, msgId: string | undefined) =>
      !!method && (!!msgId || method === ACP_METHODS.requestPermission);

    const scheduleIdleCheck = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (done) return;
      const nextMs = idleWarningFired ? Math.max(0, idleStallMs - idleWarningMs) : idleWarningMs;
      idleTimer = setTimeout(() => {
        if (done || eventCount === 0) return;
        const rawIdle = Date.now() - lastEventAt;
        const idleSinceMs = Math.max(rawIdle, idleWarningFired ? idleStallMs : idleWarningMs);
        if (!idleWarningFired) {
          idleWarningFired = true;
          const updateType = pendingTool ? 'stream_tool_wait_warning' : 'stream_idle_warning';
          injectSynthetic({ sessionUpdate: updateType, idleSinceMs, eventCount, timestamp: Date.now() });
          scheduleIdleCheck();
        } else if (!pendingTool) {
          log.error({ sessionId, idleSinceMs, eventCount }, 'HTTP stream idle stall — terminating');
          this.cancelSession(sessionId);
          controller.abort();
          promptError = new AcpStreamIdleError(sessionId, idleSinceMs, eventCount);
          done = true;
          wakeConsumer();
        }
      }, nextMs);
    };

    // Start HTTP streaming request
    this.capacityListeners.add(capacityInjector);
    resetBudget();

    const streamPromise = (async () => {
      try {
        const resp = await fetch(this.baseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        });
        if (!resp.ok) {
          throw new Error(`ACP HTTP ${resp.status}: ${await resp.text()}`);
        }
        if (!resp.body) throw new Error('ACP HTTP: no response body');

        // Read NDJSON lines from streaming response
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(trimmed) as Record<string, unknown>;
            } catch {
              log.warn('ACP HTTP non-JSON line: %s', trimmed.slice(0, 120));
              continue;
            }

            // #712: id can be 0 (Kimi CLI uses numeric ids). Use explicit null check.
            const rawMsgId = msg.id as string | number | undefined;
            const msgId = rawMsgId != null ? String(rawMsgId) : undefined;
            const method = msg.method as string | undefined;

            if (msgId === id && !method) {
              // Final response to our prompt request — protocol is done
              finalResponseReceived = true;
              const resp = msg as unknown as AcpResponse;
              if (resp.error) {
                promptError = new AcpProtocolError(resp.error.code, resp.error.message, resp.error.data);
              } else {
                const result = resp.result as unknown as AcpPromptResult;
                stopReason = result.stopReason;
              }
              done = true;
              wakeConsumer();
              await reader.cancel();
              return;
            } else if (isAgentRequest(method, msgId)) {
              try {
                await handleAgentRequestFromStream(msg, msgId);
              } catch (err) {
                if (controller.signal.aborted && promptError) return;
                failPrompt(err);
                return;
              }
            } else if (method && !msgId) {
              // Notification (session update)
              const params = (msg as unknown as AcpNotification).params as unknown as AcpSessionUpdate;
              enqueueSessionUpdate(params);
            }
          }
        }

        // Process any remaining buffer
        if (buffer.trim()) {
          try {
            const msg = JSON.parse(buffer.trim()) as Record<string, unknown>;
            // #712: same numeric id treatment as main loop
            const rawBufId = msg.id as string | number | undefined;
            const msgId = rawBufId != null ? String(rawBufId) : undefined;
            const method = msg.method as string | undefined;
            if (msgId === id && !method) {
              finalResponseReceived = true;
              const resp = msg as unknown as AcpResponse;
              if (resp.error) {
                promptError = new AcpProtocolError(resp.error.code, resp.error.message, resp.error.data);
              } else {
                const result = resp.result as unknown as AcpPromptResult;
                stopReason = result.stopReason;
              }
            } else if (isAgentRequest(method, msgId)) {
              await handleAgentRequestFromStream(msg, msgId);
            } else if (method && !msgId) {
              const params = (msg as unknown as AcpNotification).params as unknown as AcpSessionUpdate;
              enqueueSessionUpdate(params);
            }
          } catch (err) {
            failPrompt(err);
            return;
          }
        }
        if (!finalResponseReceived && !promptError && !controller.signal.aborted) {
          promptError = new AcpProtocolError(-32000, 'ACP HTTP stream closed before final prompt response');
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          promptError = err instanceof Error ? err : new Error(String(err));
        }
      } finally {
        done = true;
        wakeConsumer();
      }
    })();

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) break;
        await new Promise<void>((r) => {
          waitResolve = r;
        });
      }
      while (queue.length > 0) yield queue.shift()!;
      await streamPromise; // Ensure cleanup
      if (promptError) throw promptError;
      return stopReason;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (budgetTimer) clearTimeout(budgetTimer);
      this.capacityListeners.delete(capacityInjector);
    }
  }

  cancelSession(sessionId: string): void {
    if (!this.port || this.closed || this.exited) return;
    const body = JSON.stringify({ jsonrpc: '2.0', method: ACP_METHODS.sessionCancel, params: { sessionId } });
    fetch(this.baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch((err) => {
      log.warn({ sessionId, err: err instanceof Error ? err.message : String(err) }, 'ACP HTTP cancel failed');
    });
    log.info('Sent HTTP session/cancel for %s', sessionId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.child && !this.child.killed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (this.child && !this.child.killed) this.child.kill('SIGKILL');
          resolve();
        }, KILL_GRACE_MS);
        this.child!.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        this.child!.kill('SIGTERM');
      });
    }
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }
  get isAlive(): boolean {
    return this.child !== null && !this.child.killed && !this.closed && !this.exited;
  }

  onCapacity(fn: (signal: AcpCapacitySignal) => void): void {
    this.capacityListeners.add(fn);
  }
  offCapacity(fn: (signal: AcpCapacitySignal) => void): void {
    this.capacityListeners.delete(fn);
  }
  get recentCapacitySignal(): AcpCapacitySignal | null {
    return this._recentCapacitySignal;
  }
  clearRecentCapacitySignal(): void {
    this._recentCapacitySignal = null;
  }

  // ── MCP capability filtering (same logic as AcpClient) ──────

  private filterMcpByCapabilities(servers: AcpMcpServer[]): AcpMcpServer[] {
    const caps = this.initResult?.agentCapabilities?.mcpCapabilities;
    if (!caps) return servers;
    return servers.filter((s) => {
      if ('type' in s) {
        if (s.type === 'http') return caps.http === true;
        if (s.type === 'sse') return caps.sse === true;
        return false;
      }
      return true;
    });
  }

  // ── Internal ────────────────────────────────────────────────

  private discoverPort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      if (!this.child?.stdout) {
        reject(new Error('ACP HTTP: no stdout'));
        return;
      }
      let settled = false;
      const timeoutMs = this.config.portDiscoveryTimeoutMs ?? PORT_DISCOVERY_TIMEOUT_MS;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`ACP HTTP: port discovery timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const rl = createInterface({ input: this.child.stdout });
      rl.on('line', (line) => {
        const match = PORT_RE.exec(line);
        if (match) {
          if (settled) return;
          settled = true;
          const port = Number(match[1]);
          clearTimeout(timer);
          resolve(port);
        } else {
          // Log non-port stdout lines (could be startup messages)
          log.debug({ pid: this.child?.pid }, '[acp-http stdout] %s', line.slice(0, 200));
        }
      });
      rl.on('close', () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(new Error('ACP HTTP: stdout closed before port discovered'));
      });
    });
  }

  private async httpRequest(method: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<AcpResponse> {
    if (!this.port || this.closed || this.exited) {
      throw new Error('ACP HTTP client not connected');
    }

    const id = randomUUID();
    const body = JSON.stringify({ jsonrpc: '2.0', method, id, params });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    log.info({ method, id, timeoutMs, pid: this.child?.pid, port: this.port }, 'ACP HTTP request');
    const t0 = Date.now();

    try {
      const resp = await fetch(this.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`ACP HTTP ${resp.status}: ${text}`);
      }

      // For non-streaming requests, response is a single JSON object
      const text = await resp.text();
      const result = JSON.parse(text) as AcpResponse;
      log.info({ method, id, durationMs: Date.now() - t0, hasError: !!result.error }, 'ACP HTTP response');

      if (result.error) {
        throw new AcpProtocolError(result.error.code, result.error.message, result.error.data);
      }
      return result;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof AcpProtocolError) throw err;
      if (controller.signal.aborted) throw new AcpTimeoutError(method, timeoutMs);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async handleAgentRequest(req: AcpAgentRequest, options: AgentResponseOptions = {}): Promise<void> {
    const responseOptions = {
      timeoutMs: options.responseTimeoutMs,
      signal: options.signal,
      method: req.method,
    };

    if (req.method === ACP_METHODS.requestPermission) {
      const respond = (result: { optionId: string }) => {
        const acpResult = {
          outcome: { outcome: 'selected' as const, optionId: result.optionId },
        };
        return this.sendAgentResponse({ jsonrpc: '2.0', id: req.id, result: acpResult }, responseOptions);
      };

      if (this.config.permissionHandler) {
        let responsePromise: Promise<void> | null = null;
        try {
          this.config.permissionHandler(req, (result) => {
            responsePromise = respond(result);
          });
        } catch (err) {
          log.error('HTTP permissionHandler threw: %s', (err as Error).message);
          await this.sendAgentResponse(
            {
              jsonrpc: '2.0',
              id: req.id,
              error: { code: -32603, message: `Permission handler error: ${(err as Error).message}` },
            },
            responseOptions,
          );
          return;
        }
        if (responsePromise) await responsePromise;
      } else {
        // Prefer allow_always (session-wide) over allow_once to avoid repeated permission
        // prompts for every MCP tool call. Kimi sends optionId "approve_for_session" for this.
        const params = req.params as unknown as AcpPermissionRequest;
        const allowOption =
          params.options?.find((o) => o.kind === 'allow_always') ??
          params.options?.find((o) => o.kind === 'allow_once') ??
          params.options?.[0];
        await respond({ optionId: allowOption?.optionId ?? 'allow_once' });
      }
      return;
    }

    log.warn('Unhandled ACP HTTP agent request: %s', req.method);
    await this.sendAgentResponse(
      {
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32601, message: `Client does not handle ${req.method}` },
      },
      responseOptions,
    );
  }

  private async sendAgentResponse(
    response: AcpResponse,
    options: { timeoutMs?: number; signal?: AbortSignal; method?: string } = {},
  ): Promise<void> {
    if (!this.port || this.closed || this.exited) {
      throw new Error('ACP HTTP client not connected');
    }

    const timeoutMs = options.timeoutMs ?? 60_000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    const body = JSON.stringify(response);

    try {
      await new Promise<void>((resolve, reject) => {
        const req = nodeHttpRequest(
          this.baseUrl,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
              Connection: 'close',
            },
            agent: false,
            signal,
          },
          (resp) => {
            const chunks: Buffer[] = [];
            resp.on('data', (chunk: Buffer | string) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            resp.on('end', () => {
              if ((resp.statusCode ?? 0) < 200 || (resp.statusCode ?? 0) >= 300) {
                reject(
                  new Error(`ACP HTTP agent response ${resp.statusCode ?? 0}: ${Buffer.concat(chunks).toString()}`),
                );
                return;
              }
              resolve();
            });
            resp.on('error', reject);
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    } catch (err) {
      if (timeoutSignal.aborted) {
        throw new AcpTimeoutError(options.method ?? 'agent/response', timeoutMs);
      }
      throw err;
    }
    log.debug({ id: response.id, hasError: !!response.error }, 'ACP HTTP agent response sent');
  }
}
