import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { configuredCredentialValues } from '@cat-cafe/mcp-server/dist/secret-runtime.js';
import { AcpCwdIdentityTracker } from '@clowder-ai/agent-access/runtime/acp/acp-cwd-identity';
import type { AcpPromptInput } from '@clowder-ai/agent-access/runtime/acp/acp-prompt-content';
import {
  ACP_METHODS,
  type AcpInitializeResult,
  type AcpMcpServer,
  type AcpNewSessionResult,
  type AcpPromptCapabilities,
  type AcpSessionUpdate,
  type AcpStopReason,
  type AgentAccessAcpSessionFailure,
  agentAccessAcpSessionFailureSchema,
  agentAccessAcpTurnFrameSchema,
} from '@clowder-ai/agent-contract/acp';
import { z } from 'zod';
import {
  ACP_CHILD_SHUTDOWN_GRACE_MS,
  type AcpCapacitySignal,
  type AcpChildConnection,
  type AcpClientConfig,
  AcpProtocolError,
  AcpSessionCancelledError,
  AcpStreamIdleError,
  AcpTimeoutError,
  launchAcpChild,
} from '../../cats/services/agents/providers/acp/AcpClient.js';
import {
  AcpSessionBindingError,
  acpSessionBindingSignature,
} from '../../cats/services/agents/providers/acp/active-session-cache.js';
import { sanitizeRawEvent } from '../../cats/services/agents/providers/codex-audit-hooks.js';
import { createNativeAcpRequests } from './acp-native-requests.js';
import type { AgentAccessAcpProcess, BoundSessionOperation } from './acp-process.js';
import { type AcpWriteApproval, createAcpWriteApprovalPort } from './acp-write-approval.js';

const sessionResultSchema = z.object({ sessionId: z.string().min(1) }).passthrough();
const actionResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown().optional() }),
  z.object({ ok: z.literal(false), failure: agentAccessAcpSessionFailureSchema }),
]);

function nativeError(failure: AgentAccessAcpSessionFailure): Error {
  switch (failure.kind) {
    case 'protocol':
      return new AcpProtocolError(failure.code, failure.message, failure.data);
    case 'binding':
      return new AcpSessionBindingError(failure.message);
    case 'timeout':
      return new AcpTimeoutError(failure.method, failure.timeoutMs);
    case 'idle':
      return new AcpStreamIdleError(
        failure.sessionId,
        failure.idleSinceMs,
        failure.eventCount,
        failure.configuredIdleStallMs,
      );
    case 'cancelled':
      return new AcpSessionCancelledError(failure.sessionId);
    default:
      return new Error(failure.message);
  }
}

/** The pool keeps synchronous Host facts while the activated package drives ACP. */
export class AgentAccessAcpRuntimeClient {
  readonly #opaqueKey = randomBytes(32);
  readonly #cwd: AcpCwdIdentityTracker;
  readonly #unconfirmed = new Set<string>();
  readonly #finalResponses = new Set<string>();
  readonly #cancelApprovals = new Map<
    string,
    { contentRef: string; revoke: () => void; active: boolean; requested: boolean; queued: boolean; sent: boolean }
  >();
  readonly #capacityListeners = new Set<(signal: AcpCapacitySignal) => void>();
  #connection?: Awaited<ReturnType<AgentAccessAcpProcess>>;
  #child?: AcpChildConnection;
  #exited = false;
  #closing?: Promise<void>;
  #nativeEnv: NodeJS.ProcessEnv = {};
  #wire?: ReturnType<typeof createAcpWriteApprovalPort>;
  #requests?: ReturnType<typeof createNativeAcpRequests>;
  #capabilities?: AcpInitializeResult['agentCapabilities'];
  #recentCapacity: AcpCapacitySignal | null = null;

  constructor(
    private readonly config: AcpClientConfig,
    private readonly open: AgentAccessAcpProcess,
  ) {
    this.#cwd = new AcpCwdIdentityTracker(config.cwd);
  }

  get spawnContext() {
    return { cwd: this.config.cwd, env: this.#nativeEnv };
  }
  get pid() {
    return this.#child?.pid;
  }
  get hasExited() {
    return this.#exited;
  }
  get isAlive() {
    return !this.#closing && !this.#exited && this.#child?.isWritable() === true;
  }
  get isCwdIntact() {
    return this.#cwd.isIntact;
  }
  get agentCapabilities() {
    return this.#capabilities;
  }
  get promptCapabilities(): Readonly<AcpPromptCapabilities> | undefined {
    return this.#capabilities && { ...this.#capabilities.promptCapabilities };
  }
  get isSafeForSingleFlightReuse() {
    return this.#unconfirmed.size === 0;
  }
  isSessionSafeForReuse(sessionId: string) {
    return !this.#unconfirmed.has(sessionId);
  }
  hasPromptFinalResponse(sessionId: string) {
    return this.#finalResponses.has(sessionId);
  }
  hasUnconfirmedPrompt(sessionId: string) {
    return this.#unconfirmed.has(sessionId);
  }
  get recentCapacitySignal() {
    return this.#recentCapacity;
  }
  clearRecentCapacitySignal() {
    this.#recentCapacity = null;
  }
  onCapacity(listener: (signal: AcpCapacitySignal) => void) {
    this.#capacityListeners.add(listener);
  }
  offCapacity(listener: (signal: AcpCapacitySignal) => void) {
    this.#capacityListeners.delete(listener);
  }

  async initialize() {
    this.#connection = await this.open(this.config.cwd, () => {
      const native = launchAcpChild(this.config, () => this.#cwd.capture());
      this.#child = native.child;
      this.#nativeEnv = native.childEnv;
      native.child.onExit(() => {
        this.#exited = true;
      });
      this.#wire = createAcpWriteApprovalPort(native.writeLine);
      const knownCredentials = configuredCredentialValues({
        ...process.env,
        ...this.config.preparedEnv,
        ...this.config.env,
      });
      this.#requests = createNativeAcpRequests({
        defaultDecision: this.config.defaultPermissionDecision,
        defaultHandler: this.config.permissionHandler,
        knownCredentials,
        write: native.writeLine,
        onWriteError: () => {
          void this.close().catch(() => {});
        },
      });
      if (!native.child.stdout) throw new Error('ACP provider stdout unavailable');
      const stderr = native.child.stderr;
      return {
        child: native.child,
        stdout: this.#requests.project(native.child.stdout),
        stderr: stderr
          ? Readable.from(
              (async function* () {
                const lines = createInterface({ input: stderr, crlfDelay: Infinity });
                try {
                  for await (const line of lines) yield String(sanitizeRawEvent(line, knownCredentials)) + '\n';
                } finally {
                  lines.close();
                }
              })(),
              { objectMode: false },
            )
          : undefined,
        writeApprovedLine: this.#wire.writeApprovedLine,
        onCapacity: (signal: AcpCapacitySignal) => {
          this.#recentCapacity = signal;
          for (const listener of this.#capacityListeners) listener(signal);
        },
      };
    });
    const revoke = this.#wire?.approve({ method: ACP_METHODS.initialize, params: { protocolVersion: 1 } });
    try {
      const result = (await this.#connection.initialize()) as AcpInitializeResult;
      this.#capabilities = result.agentCapabilities;
      return result;
    } finally {
      revoke?.();
    }
  }

  close() {
    for (const approval of this.#cancelApprovals.values()) approval.revoke();
    this.#cancelApprovals.clear();
    this.#closing ??=
      this.#connection?.close() ?? this.#child?.shutdown(ACP_CHILD_SHUTDOWN_GRACE_MS, false) ?? Promise.resolve();
    return this.#closing;
  }

  async #command(operation: BoundSessionOperation, approval: AcpWriteApproval) {
    if (!this.#connection || !this.#wire) throw new Error('ACP provider process unavailable');
    const revoke = this.#wire.approve(approval);
    try {
      const result = actionResultSchema.parse(await this.#connection.session(operation));
      if (!result.ok) throw nativeError(result.failure);
      return result.result;
    } finally {
      revoke();
    }
  }

  async #openSession(
    operation: 'newSession' | 'loadSession' | 'resumeSession',
    cwd: string,
    servers: AcpMcpServer[],
    sessionId?: string,
  ): Promise<AcpNewSessionResult> {
    const occurrences = new Map<string, number>();
    const byReference = new Map(
      servers.map((server) => {
        const signature = acpSessionBindingSignature('', [server]);
        const occurrence = occurrences.get(signature) ?? 0;
        occurrences.set(signature, occurrence + 1);
        const ref = createHmac('sha256', this.#opaqueKey).update(signature).update(String(occurrence)).digest('hex');
        return [ref, server] as const;
      }),
    );
    const mcp = [...byReference].map(([ref, server]) => ({
      ref,
      transport: 'type' in server ? server.type : ('stdio' as const),
    }));
    const request =
      operation === 'newSession'
        ? ({ operation, cwd, mcp } as const)
        : { operation, cwd, mcp, sessionId: sessionId ?? '' };
    const resumeOnLoad =
      operation === 'loadSession' &&
      !this.#capabilities?.loadSession &&
      Boolean(this.#capabilities?.sessionCapabilities?.resume);
    const method =
      operation === 'newSession'
        ? ACP_METHODS.sessionNew
        : operation === 'resumeSession' || resumeOnLoad
          ? ACP_METHODS.sessionResume
          : ACP_METHODS.sessionLoad;
    return sessionResultSchema.parse(
      await this.#command(request, {
        method,
        params: { cwd, ...(sessionId === undefined ? {} : { sessionId }) },
        mcp: byReference,
      }),
    );
  }

  newSession(cwd = this.config.cwd, servers: AcpMcpServer[] = []) {
    return this.#openSession('newSession', cwd, servers);
  }
  loadSession(sessionId: string, cwd = this.config.cwd, servers: AcpMcpServer[] = []) {
    return this.#openSession('loadSession', cwd, servers, sessionId);
  }
  resumeSession(sessionId: string, cwd = this.config.cwd, servers: AcpMcpServer[] = []) {
    return this.#openSession('resumeSession', cwd, servers, sessionId);
  }
  async closeSession(sessionId: string) {
    await this.#command(
      { operation: 'closeSession', sessionId },
      { method: ACP_METHODS.sessionClose, params: { sessionId: sessionId.trim() } },
    );
    this.#requests?.setSessionPermissionHandler(sessionId);
    this.#requests?.setSessionRequestHandler(sessionId);
    this.#unconfirmed.delete(sessionId);
    this.#finalResponses.delete(sessionId);
  }
  async setSessionModel(sessionId: string, modelId: string) {
    await this.#command(
      { operation: 'setModel', sessionId, modelId },
      { method: ACP_METHODS.sessionSetModel, params: { sessionId: sessionId.trim(), modelId: modelId.trim() } },
    );
  }
  async setSessionConfigOption(sessionId: string, configId: string, value: string) {
    await this.#command(
      { operation: 'setConfig', sessionId, configId, value },
      {
        method: ACP_METHODS.sessionSetConfigOption,
        params: { sessionId, configId: configId.trim(), value },
      },
    );
  }
  setSessionPermissionHandler(
    ...args: Parameters<ReturnType<typeof createNativeAcpRequests>['setSessionPermissionHandler']>
  ) {
    this.#requests?.setSessionPermissionHandler(...args);
  }
  setSessionRequestHandler(
    ...args: Parameters<ReturnType<typeof createNativeAcpRequests>['setSessionRequestHandler']>
  ) {
    this.#requests?.setSessionRequestHandler(...args);
  }
  #allowCancel(
    wire: ReturnType<typeof createAcpWriteApprovalPort>,
    sessionId: string,
    contentRef: string,
    revokePrompt: () => void,
  ) {
    const approval = {
      contentRef,
      active: true,
      requested: false,
      queued: false,
      sent: false,
      revoke() {
        revokeCancel();
        revokePrompt();
      },
    };
    const revokeCancel = wire.approve({
      method: ACP_METHODS.sessionCancel,
      params: { sessionId },
      onAccepted: () => {
        approval.sent = true;
        if (!approval.active) this.#cancelApprovals.delete(sessionId);
        revokePrompt();
        this.#requests?.setSessionPermissionHandler(sessionId, (_request, respond) => respond({ cancelled: true }));
      },
    });
    this.#cancelApprovals.set(sessionId, approval);
    return approval;
  }

  cancelSession(sessionId: string) {
    this.#requests?.setSessionPermissionHandler(sessionId, (_request, respond) => respond({ cancelled: true }));
    const approval = this.#cancelApprovals.get(sessionId);
    if (!this.#connection || !this.isAlive || !approval || approval.queued || approval.requested || approval.sent)
      return;
    approval.requested = true;
    void this.#connection
      .session({ operation: 'cancel', sessionId, contentRef: approval.contentRef })
      .then((value) => {
        const result = actionResultSchema.parse(value);
        if (!result.ok) throw nativeError(result.failure);
        approval.requested = false;
        approval.queued ||= result.result === true;
        if (!approval.active && !approval.queued && this.#cancelApprovals.get(sessionId) === approval) {
          approval.revoke();
          this.#cancelApprovals.delete(sessionId);
        }
      })
      .catch(() => this.close())
      .catch(() => {});
  }

  async *promptStream(
    sessionId: string,
    input: AcpPromptInput,
    limits?: { timeoutMs?: number; idleWarningMs?: number; idleStallMs?: number },
  ): AsyncGenerator<AcpSessionUpdate, AcpStopReason> {
    if (!this.#connection || !this.#wire) throw new Error('ACP provider process unavailable');
    const pendingCancel = this.#cancelApprovals.get(sessionId);
    if (pendingCancel?.active) throw new AcpProtocolError(-32600, 'ACP session already has an active prompt');
    if (pendingCancel) throw new AcpSessionCancelledError(sessionId);
    const ref = randomUUID();
    this.#finalResponses.delete(sessionId);
    const revokePrompt = this.#wire.approve({
      method: ACP_METHODS.sessionPrompt,
      params: { sessionId },
      prompt: { ref, content: typeof input === 'string' ? [{ type: 'text', text: input }] : input },
      onAccepted: () => {
        this.#unconfirmed.add(sessionId);
      },
    });
    const cancel = this.#allowCancel(this.#wire, sessionId, ref, revokePrompt);
    let ended = false;
    try {
      const frames = await this.#connection.session({ operation: 'prompt', sessionId, contentRef: ref, limits });
      if (!frames || typeof frames !== 'object' || !(Symbol.asyncIterator in frames))
        throw new Error('invalid_acp_provider_stream');
      for await (const raw of frames as AsyncIterable<unknown>) {
        const frame = agentAccessAcpTurnFrameSchema.parse(raw);
        if (frame.kind === 'terminal') {
          ended = true;
          cancel.queued ||= frame.cancelQueued;
          if (frame.finalResponse) this.#finalResponses.add(sessionId);
          if (frame.sessionReusable) this.#unconfirmed.delete(sessionId);
          else if (frame.cancelQueued) this.#unconfirmed.add(sessionId);
          if ('failure' in frame.result) throw nativeError(frame.result.failure);
          return frame.result.stopReason;
        }
        if (frame.update.sessionId !== sessionId) throw new Error('invalid_acp_provider_update');
        yield frame.update as AcpSessionUpdate;
      }
      throw new Error('incomplete_acp_provider_stream');
    } finally {
      if (!ended) this.cancelSession(sessionId);
      cancel.active = false;
      // The turn terminal and command are on separate streams. Keep the grant
      // until the queued native cancel reaches stdin, including watchdog stops.
      if (cancel.sent || !(cancel.requested || cancel.queued)) {
        cancel.revoke();
        this.#cancelApprovals.delete(sessionId);
      }
    }
  }
}
