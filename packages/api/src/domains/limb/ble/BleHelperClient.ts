import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { BleAdapterReadiness } from './BleAdapterReadiness.js';
import type {
  BleHelperClientOptions,
  BleHelperClientState,
  BleHelperClientStatus,
  BleHelperLogger,
} from './BleHelperClientTypes.js';
import { asError, BleHelperCompatibilityError, isCompatibilityError } from './BleHelperErrors.js';
import { type BleHelperProcess, spawnBleHelperProcess } from './BleHelperProcess.js';
import { type BleHelperEvent, type BleHelperInboundMessage, encodeBleHelperRequest } from './BleHelperProtocol.js';
import { frameBleHelperChunk, tryParseBleHelperMessage } from './BleHelperStream.js';

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

const RESTART_DELAYS_MS = [1_000, 2_000, 4_000] as const;

export class BleHelperClient extends EventEmitter {
  private readonly platform: string;
  private readonly spawnProcess: () => BleHelperProcess;
  private readonly handshakeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly setRequestTimer: (callback: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearRequestTimer: (timer: NodeJS.Timeout) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: BleHelperLogger;
  private process: BleHelperProcess | null = null;
  private state: BleHelperClientState;
  private reason: string | null = null;
  private restartAttempts = 0;
  private recoveryPromise: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly adapterReadiness: BleAdapterReadiness;
  private stopping = false;
  private lastError: Error | null = null;

  constructor(options: BleHelperClientOptions = {}) {
    super();
    this.platform = options.platform ?? process.platform;
    this.spawnProcess = options.spawnProcess ?? (() => spawnBleHelperProcess(options.helperPath));
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 3_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.setRequestTimer = options.setRequestTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearRequestTimer = options.clearRequestTimer ?? ((timer) => clearTimeout(timer));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
    this.logger = options.logger ?? console;
    this.adapterReadiness = new BleAdapterReadiness(this, this.handshakeTimeoutMs);
    this.state = this.platform === 'darwin' ? 'idle' : 'unsupported';
    if (this.state === 'unsupported') this.reason = 'BLE helper is only available on macOS in Phase A';
  }

  get status(): BleHelperClientStatus {
    return { state: this.state, reason: this.reason, restartAttempts: this.restartAttempts };
  }

  /** @internal Test-only inspection; production callers use status and request(). */
  get currentProcessForTest(): BleHelperProcess | null {
    return this.process;
  }

  async start(): Promise<void> {
    if (this.state === 'ready') return;
    if (this.state === 'unsupported') throw new Error(this.reason ?? 'BLE helper is unsupported');
    if (!this.recoveryPromise) this.beginRecovery(true);
    await this.recoveryPromise;
    if (this.status.state !== 'ready') {
      throw new Error(`BLE helper unavailable: ${this.lastError?.message ?? this.reason ?? 'unknown error'}`);
    }
  }

  async request(command: string, params: Record<string, unknown>): Promise<unknown> {
    await this.start();
    if (command !== 'helper.shutdown') await this.adapterReadiness.waitForPoweredOn();
    const child = this.process;
    if (!child || this.state !== 'ready') throw new Error('BLE helper is not ready');

    const requestId = randomUUID();
    const line = encodeBleHelperRequest(command, params, requestId);
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      const timer = this.setRequestTimer(() => {
        this.pending.delete(requestId);
        rejectRequest(new Error(`BLE helper request timed out: ${command}`));
      }, this.requestTimeoutMs);
      timer.unref();
      this.pending.set(requestId, { resolve: resolveRequest, reject: rejectRequest, timer });
      try {
        child.stdin.write(line, (error) => {
          if (!error) return;
          const pending = this.pending.get(requestId);
          if (!pending) return;
          this.clearRequestTimer(pending.timer);
          this.pending.delete(requestId);
          pending.reject(asError(error));
        });
      } catch (error) {
        this.clearRequestTimer(timer);
        this.pending.delete(requestId);
        rejectRequest(asError(error));
      }
    });
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    const activeRecovery = this.recoveryPromise;
    const child = this.process;
    if (child && this.state === 'ready') {
      try {
        await this.request('helper.shutdown', {});
      } catch {
        // Continue with process termination.
      }
    }
    this.rejectPending(new Error('BLE helper is shutting down'));
    child?.kill('SIGTERM');
    this.process = null;
    this.adapterReadiness.reset();
    this.setState(this.platform === 'darwin' ? 'idle' : 'unsupported', null);
    if (activeRecovery) {
      // Keep the stop barrier raised until an in-flight backoff wakes and
      // observes it. Otherwise a delayed recovery can spawn a new helper
      // after API shutdown has already completed.
      void activeRecovery
        .finally(() => {
          this.stopping = false;
        })
        .catch(() => {});
    } else {
      this.stopping = false;
    }
  }

  private beginRecovery(initialStart: boolean): void {
    if (this.recoveryPromise) return;
    const recovery = this.runRecovery(initialStart).finally(() => {
      if (this.recoveryPromise === recovery) this.recoveryPromise = null;
    });
    this.recoveryPromise = recovery;
  }

  private async runRecovery(initialStart: boolean): Promise<void> {
    if (this.stopping) return;
    this.restartAttempts = 0;
    if (initialStart && (await this.attemptRecovery())) return;
    for (const delayMs of RESTART_DELAYS_MS) {
      if (await this.attemptRecovery(delayMs)) return;
    }
    this.setState('degraded', this.lastError?.message ?? 'BLE helper restart attempts exhausted');
  }

  private async attemptRecovery(delayMs?: number): Promise<boolean> {
    if (this.stopping) return true;
    if (delayMs !== undefined) {
      this.restartAttempts += 1;
      await this.sleep(delayMs);
      if (this.stopping) return true;
    }
    try {
      await this.spawnAndHandshake();
      return true;
    } catch (error) {
      this.lastError = asError(error);
      if (!isCompatibilityError(this.lastError)) return false;
      this.setState('degraded', this.lastError.message);
      return true;
    }
  }

  private spawnAndHandshake(): Promise<void> {
    this.setState('starting', null);
    this.adapterReadiness.reset();
    let child: BleHelperProcess;
    try {
      child = this.spawnProcess();
    } catch (error) {
      return Promise.reject(asError(error));
    }
    this.process = child;

    return new Promise<void>((resolveHandshake, rejectHandshake) => {
      let ready = false;
      let settled = false;
      let buffer = '';
      const decoder = new StringDecoder('utf8');

      const cleanup = (): void => {
        clearTimeout(handshakeTimer);
        child.stdout.off('data', onData);
        child.stderr.off('data', onStderr);
        child.off('exit', onExit);
        child.off('error', onError);
      };

      const failBeforeReady = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (this.process === child) this.process = null;
        child.kill('SIGTERM');
        rejectHandshake(error);
      };

      const handleRuntimeProtocolViolation = (error: Error): void => {
        cleanup();
        if (this.process === child) this.process = null;
        this.lastError = error;
        this.rejectPending(error);
        child.kill('SIGTERM');
        this.setState('degraded', error.message);
      };

      const handleProtocolError = (error: Error): boolean => {
        if (!ready) {
          const handshakeError = isCompatibilityError(error) ? new BleHelperCompatibilityError(error.message) : error;
          failBeforeReady(handshakeError);
          return true;
        }
        if (isCompatibilityError(error)) {
          handleRuntimeProtocolViolation(new BleHelperCompatibilityError(error.message));
          return true;
        }
        this.logger.warn(`Ignoring invalid BLE helper message: ${error.message}`);
        return false;
      };

      const acceptMessage = (message: BleHelperInboundMessage): boolean => {
        if (ready) {
          this.dispatchMessage(message);
          return true;
        }
        if (message.kind !== 'hello') {
          failBeforeReady(new BleHelperCompatibilityError('BLE helper did not send hello before other messages'));
          return false;
        }
        ready = true;
        settled = true;
        clearTimeout(handshakeTimer);
        this.lastError = null;
        this.setState('ready', null);
        resolveHandshake();
        return true;
      };

      const handleLine = (line: string): boolean => {
        const parsed = tryParseBleHelperMessage(line);
        return parsed.ok ? acceptMessage(parsed.message) : !handleProtocolError(parsed.error);
      };

      const onData = (chunk: Buffer | string): void => {
        const framed = frameBleHelperChunk(buffer, Buffer.isBuffer(chunk) ? decoder.write(chunk) : chunk);
        buffer = framed.rest;
        if (framed.oversizedRest) {
          handleProtocolError(new BleHelperCompatibilityError('BLE helper message exceeds line size limit'));
          return;
        }
        framed.lines.every(handleLine);
      };

      const onStderr = (chunk: Buffer | string): void => {
        const message = (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk).trim().slice(0, 512);
        if (message) this.logger.warn(`BLE helper: ${message}`);
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        const error = new Error(`BLE helper exited (code=${String(code)}, signal=${String(signal)})`);
        if (!ready) {
          failBeforeReady(error);
          return;
        }
        cleanup();
        this.handleUnexpectedExit(child, error);
      };

      const onError = (error: Error): void => {
        if (!ready) {
          failBeforeReady(error);
          return;
        }
        cleanup();
        this.handleUnexpectedExit(child, error);
      };

      const handshakeTimer = setTimeout(
        () => failBeforeReady(new Error('BLE helper handshake timed out')),
        this.handshakeTimeoutMs,
      );
      handshakeTimer.unref();
      child.stdout.on('data', onData);
      child.stderr.on('data', onStderr);
      child.on('exit', onExit);
      child.on('error', onError);
    });
  }

  private dispatchMessage(message: BleHelperInboundMessage): void {
    if (message.kind === 'event') {
      this.adapterReadiness.observe(message as BleHelperEvent);
      this.emit('event', message as BleHelperEvent);
      return;
    }
    if (message.kind === 'hello') {
      this.logger.warn('Ignoring duplicate BLE helper hello');
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) {
      this.logger.warn(`Ignoring BLE helper response for unknown request: ${message.requestId}`);
      return;
    }
    this.clearRequestTimer(pending.timer);
    this.pending.delete(message.requestId);
    if (message.ok) pending.resolve(message.data);
    else pending.reject(new Error(message.error ?? 'BLE helper request failed'));
  }

  private handleUnexpectedExit(child: BleHelperProcess, error: Error): void {
    if (this.process !== child) return;
    this.process = null;
    this.adapterReadiness.reset();
    this.lastError = error;
    this.rejectPending(error);
    if (this.stopping) {
      this.setState('idle', null);
      return;
    }
    this.setState('degraded', error.message);
    this.beginRecovery(false);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      this.clearRequestTimer(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private setState(state: BleHelperClientState, reason: string | null): void {
    this.state = state;
    this.reason = reason;
    this.emit('state', this.status);
  }
}
