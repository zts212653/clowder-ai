/**
 * Antigravity Agent Service — Bridge-owned writeback architecture.
 *
 * Replaces CDP WebSocket hack with ConnectRPC via AntigravityBridge.
 * Antigravity thinks (via LS cascade), Bridge reads back and yields AgentMessages.
 */
import { join } from 'node:path';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import {
  GENAI_MODEL,
  GENAI_SYSTEM,
  STREAM_ERROR_PATH,
} from '../../../../../../infrastructure/telemetry/genai-semconv.js';
import {
  antigravityStreamErrorBuffered,
  antigravityStreamErrorExpired,
  antigravityStreamErrorRecovered,
} from '../../../../../../infrastructure/telemetry/instruments.js';
import { normalizeModel } from '../../../../../../infrastructure/telemetry/model-normalizer.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata } from '../../../types.js';
import { AntigravityBridge, type BridgeConnection } from './AntigravityBridge.js';
import { classifyStep, transformTrajectorySteps } from './antigravity-event-transformer.js';
import { summarizeStepShape, TRACE_ENABLED, traceLog } from './antigravity-trace.js';
import { AuditLogger } from './executors/AuditLogger.js';
import { ExecutorRegistry } from './executors/ExecutorRegistry.js';
import { RunCommandExecutor } from './executors/RunCommandExecutor.js';

const log = createModuleLogger('antigravity-service');
const STREAM_ERROR_GRACE_WINDOW_MS = 4_500;

export interface AntigravityAgentServiceOptions {
  catId?: CatId;
  model?: string;
  /** Manual connection (env vars or explicit config) */
  connection?: Partial<BridgeConnection>;
  /** Inject bridge for testing */
  bridge?: AntigravityBridge;
  /** Idle stall timeout in ms — resets on each new step (default: 60s) */
  pollTimeoutMs?: number;
  /** Auto-approve pending Antigravity interactions — YOLO mode (default: true) */
  autoApprove?: boolean;
  /** Grace window for buffered stream_error after partial text (default: 4500ms) */
  streamErrorGraceWindowMs?: number;
}

export class AntigravityAgentService implements AgentService {
  readonly catId: CatId;
  private readonly model: string;
  private readonly bridge: AntigravityBridge;
  private readonly pollTimeoutMs: number;
  private readonly autoApprove: boolean;
  private readonly streamErrorGraceWindowMs: number;

  constructor(options?: AntigravityAgentServiceOptions) {
    this.catId = options?.catId
      ? typeof options.catId === 'string'
        ? createCatId(options.catId)
        : options.catId
      : createCatId('antigravity');
    this.model = options?.model ?? getCatModel(this.catId as string);
    const injectedBridge = options?.bridge;
    this.bridge = injectedBridge ?? new AntigravityBridge(options?.connection);
    this.pollTimeoutMs = options?.pollTimeoutMs ?? 60_000;
    this.autoApprove = options?.autoApprove ?? process.env['ANTIGRAVITY_AUTO_APPROVE'] !== 'false';
    this.streamErrorGraceWindowMs = options?.streamErrorGraceWindowMs ?? STREAM_ERROR_GRACE_WINDOW_MS;

    // F061 Phase 2c: auto-attach default native executors when the service owns its bridge.
    // Tests that inject a mock bridge opt out here; they stub nativeExecuteAndPush directly.
    if (!injectedBridge) {
      const registry = new ExecutorRegistry();
      registry.register(
        new RunCommandExecutor({
          rpc: (method, payload) => this.bridge.callRpc(method, payload),
        }),
      );
      const audit = new AuditLogger(join(process.cwd(), 'data', 'antigravity-audit'));
      this.bridge.attachExecutors(registry, audit);
    }
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const metadata: MessageMetadata = {
      provider: 'antigravity',
      model: this.model,
      modelVerified: !!this.bridge.resolveModelId(this.model),
    };

    try {
      // Abort check
      if (options?.signal?.aborted) {
        yield { type: 'error', catId: this.catId, error: 'Aborted before start', metadata, timestamp: Date.now() };
        yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
        return;
      }

      // Antigravity LS validates file paths against its workspace root.
      // Without this hint, the model generates absolute paths that LS rejects.
      // Sanitize path to prevent control-character prompt injection.
      const sanitizedDir = options?.workingDirectory?.split(/[\n\r\x00-\x1f]/)[0]?.trim() ?? '';
      const workspaceHint = sanitizedDir
        ? `\n[Workspace: ${sanitizedDir}]\nAll file paths must be relative to this workspace root. Do not use absolute paths.`
        : '';

      const effectivePrompt = options?.systemPrompt
        ? `${options.systemPrompt}${workspaceHint}\n\n---\n\n${prompt}`
        : workspaceHint
          ? `${workspaceHint.trimStart()}\n\n---\n\n${prompt}`
          : prompt;

      // Create cascade and send message
      const threadId = options?.auditContext?.threadId ?? `ephemeral-${Date.now()}`;
      const cascadeId = await this.bridge.getOrCreateSession(threadId, this.catId as string);
      log.info(`invoke: cascade=${cascadeId}, thread=${threadId}, model=${this.model}`);

      yield {
        type: 'session_init',
        catId: this.catId,
        sessionId: cascadeId,
        ephemeralSession: true,
        metadata,
        timestamp: Date.now(),
      };

      const stepsBefore = await this.bridge.sendMessage(cascadeId, effectivePrompt, this.model);

      // Abort check after send
      if (options?.signal?.aborted) {
        yield { type: 'error', catId: this.catId, error: 'Aborted after send', metadata, timestamp: Date.now() };
        yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
        return;
      }

      let hasText = false;
      let fatalSeen = false;
      let terminalAbort = false;
      let autoApproveAttempted = false;
      let stallProbed = false;
      let lastDelivered = stepsBefore;
      const handledToolCallIds = new Set<string>();
      let pendingStreamError: AgentMessage | null = null;
      let streamErrorGraceDeadline = 0;
      const streamErrorMetricAttrs = {
        [GENAI_SYSTEM]: 'antigravity',
        [GENAI_MODEL]: normalizeModel(this.model),
        [STREAM_ERROR_PATH]: 'partial_text',
      } as const;

      const clearPendingStreamError = (reason: 'recovered' | 'superseded' | 'expired') => {
        if (!pendingStreamError) return;
        if (reason === 'recovered') {
          antigravityStreamErrorRecovered.add(1, streamErrorMetricAttrs);
        } else if (reason === 'expired') {
          antigravityStreamErrorExpired.add(1, streamErrorMetricAttrs);
        }
        pendingStreamError = null;
        streamErrorGraceDeadline = 0;
      };

      // Diagnostic counters for empty_response observability
      let totalStepsSeen = 0;
      const rawStepTypeCounts: Record<string, number> = {};
      const transformedMessageTypeCounts: Record<string, number> = {};
      let lastBatchStepTypes: string[] = [];
      const seenUnknownKeys = new Set<string>();
      const pollOnce = async function* (self: AntigravityAgentService, fromStep: number) {
        const iterator = self.bridge
          .pollForSteps(cascadeId, fromStep, self.pollTimeoutMs, 2_000, options?.signal)
          [Symbol.asyncIterator]();

        while (true) {
          let nextBatch: Awaited<ReturnType<typeof iterator.next>>;
          if (pendingStreamError) {
            const remainingMs = streamErrorGraceDeadline - Date.now();
            if (remainingMs <= 0) {
              log.warn({ cascadeId }, 'stream_error grace expired without recovery');
              yield pendingStreamError;
              clearPendingStreamError('expired');
              terminalAbort = true;
              try {
                await iterator.return?.(undefined);
              } catch {
                // best-effort cleanup only
              }
              return;
            }

            let timeoutHandle;
            const raced = await Promise.race([
              iterator.next(),
              new Promise<'__grace_timeout__'>((resolve) => {
                timeoutHandle = setTimeout(() => resolve('__grace_timeout__'), remainingMs);
              }),
            ]);
            clearTimeout(timeoutHandle);
            if (raced === '__grace_timeout__') {
              log.warn({ cascadeId }, 'stream_error grace expired without recovery');
              yield pendingStreamError;
              clearPendingStreamError('expired');
              terminalAbort = true;
              try {
                await iterator.return?.(undefined);
              } catch {
                // best-effort cleanup only
              }
              return;
            }
            nextBatch = raced;
          } else {
            nextBatch = await iterator.next();
          }

          if (nextBatch.done) return;
          const batch = nextBatch.value;
          if (batch.cursor.awaitingUserInput) {
            if (self.autoApprove && !autoApproveAttempted) {
              autoApproveAttempted = true;
              try {
                await self.bridge.resolveOutstandingSteps(cascadeId);
                log.info(`auto-approved pending interaction for cascade ${cascadeId}`);
                continue;
              } catch (err) {
                log.warn(`auto-approve failed: ${err}`);
              }
            }
            yield {
              type: 'liveness_signal' as const,
              catId: self.catId,
              content: JSON.stringify({ type: 'info', message: 'Antigravity 正在等待权限批准' }),
              metadata,
              errorCode: 'waiting_approval',
              timestamp: Date.now(),
            };
            continue;
          }
          if (batch.steps.length > 0) {
            autoApproveAttempted = false;
            stallProbed = false;
            lastDelivered = batch.cursor.lastDeliveredStepCount;

            // Diagnostic: track raw step types per batch
            totalStepsSeen += batch.steps.length;
            lastBatchStepTypes = batch.steps.map((s) => s.type);
            for (const step of batch.steps) {
              rawStepTypeCounts[step.type] = (rawStepTypeCounts[step.type] ?? 0) + 1;
              // Log unknown_activity at info level, deduped by (type, status)
              const unknownKey = `${step.type}:${step.status}`;
              if (classifyStep(step) === 'unknown_activity' && !seenUnknownKeys.has(unknownKey)) {
                seenUnknownKeys.add(unknownKey);
                log.info('unknown step type %s (status=%s) in cascade %s', step.type, step.status, cascadeId);
              }
            }

            const messages = transformTrajectorySteps(batch.steps, self.catId, metadata);

            // Diagnostic: track transformed message types
            const batchMsgTypeCounts: Record<string, number> = {};
            for (const msg of messages) {
              transformedMessageTypeCounts[msg.type] = (transformedMessageTypeCounts[msg.type] ?? 0) + 1;
              batchMsgTypeCounts[msg.type] = (batchMsgTypeCounts[msg.type] ?? 0) + 1;
            }
            log.info(
              {
                cascadeId,
                batchSize: batch.steps.length,
                lastDelivered,
                rawStepTypes: lastBatchStepTypes,
                msgTypeCounts: batchMsgTypeCounts,
                totalStepsSeen,
              },
              'batch processed',
            );
            if (TRACE_ENABLED) {
              traceLog.info(
                { cascadeId, stepShapes: batch.steps.map((s) => summarizeStepShape(s)) },
                'step structure snapshot',
              );
            }
            const seenFatalKeys = new Set<string>();
            const batchHasSpecificError = messages.some(
              (msg) =>
                msg.type === 'error' && (msg.errorCode === 'upstream_error' || msg.errorCode === 'model_capacity'),
            );
            for (const msg of messages) {
              const isFatal = msg.type === 'error' && msg.errorCode && msg.errorCode !== 'tool_error';
              if (!isFatal) {
                if (msg.type === 'text') {
                  if (pendingStreamError) {
                    log.info({ cascadeId }, 'stream_error recovered mid-stream');
                    clearPendingStreamError('recovered');
                  }
                  hasText = true;
                }
                yield msg;
                continue;
              }

              const key = `${msg.errorCode}:${msg.error}`;
              if (seenFatalKeys.has(key)) {
                log.info('suppressed duplicate fatal error in same batch: %s', msg.error);
                continue;
              }
              seenFatalKeys.add(key);
              fatalSeen = true;

              if (msg.errorCode === 'stream_error' && batchHasSpecificError) {
                log.info('suppressed stream_error in favor of upstream_error: %s', msg.error);
                continue;
              }

              if (msg.errorCode === 'model_capacity') {
                if (pendingStreamError) {
                  log.info({ cascadeId }, 'stream_error superseded by model_capacity');
                  clearPendingStreamError('superseded');
                }
                terminalAbort = true;
                yield msg;
                continue;
              }

              if (msg.errorCode === 'upstream_error') {
                if (pendingStreamError) {
                  log.info({ cascadeId }, 'stream_error superseded by upstream_error');
                  clearPendingStreamError('superseded');
                }
                yield msg;
                continue;
              }

              if (msg.errorCode === 'stream_error' && hasText) {
                if (!pendingStreamError) {
                  antigravityStreamErrorBuffered.add(1, streamErrorMetricAttrs);
                }
                pendingStreamError = msg;
                streamErrorGraceDeadline = Date.now() + self.streamErrorGraceWindowMs;
                continue;
              }

              terminalAbort = true;
              yield msg;
            }

            // F061 Phase 2c: dispatch WAITING RUN_COMMAND steps through native executor.
            // The bridge decides eligibility; we de-dup by toolCall.id to avoid re-exec
            // if the same WAITING step is delivered in consecutive batches.
            if (terminalAbort) break;
            for (const step of batch.steps) {
              const toolCallId = step.metadata?.toolCall?.id;
              if (toolCallId && handledToolCallIds.has(toolCallId)) continue;
              try {
                const handled = await self.bridge.nativeExecuteAndPush(step, {
                  cascadeId,
                  cwd: sanitizedDir,
                  modelName: self.model,
                });
                if (handled && toolCallId) handledToolCallIds.add(toolCallId);
              } catch (err) {
                log.warn(`nativeExecuteAndPush failed for step: ${err}`);
              }
            }
          }
          if (terminalAbort) {
            log.info('terminal error detected (model_capacity/stream_error), aborting poll loop');
            return;
          }
        }
      };

      // Poll with stall-probe retry: if stall occurs and autoApprove is on,
      // try resolveOutstandingSteps as a probe (LS may not set awaitingUserInput).
      let retry = true;
      while (retry) {
        retry = false;
        try {
          for await (const msg of pollOnce(this, lastDelivered)) {
            yield msg;
          }
          if (pendingStreamError) {
            log.warn({ cascadeId }, 'stream_error grace expired after poll completion without recovery');
            yield pendingStreamError;
            clearPendingStreamError('expired');
            terminalAbort = true;
          }
        } catch (err) {
          const isStall = err instanceof Error && err.message.includes('stall');
          if (pendingStreamError && isStall) {
            log.warn({ cascadeId }, 'stream_error grace expired on stall without recovery');
            yield pendingStreamError;
            clearPendingStreamError('expired');
            terminalAbort = true;
            break;
          }
          if (isStall && this.autoApprove && !stallProbed) {
            stallProbed = true;
            try {
              await this.bridge.resolveOutstandingSteps(cascadeId);
              log.info(`probe-approved on stall for cascade ${cascadeId}, retrying poll from step ${lastDelivered}`);
              retry = true;
              continue;
            } catch (probeErr) {
              log.warn(`stall probe failed: ${probeErr}`);
            }
          }
          throw err;
        }
        if (terminalAbort) break;
      }

      if (!hasText && !fatalSeen) {
        const diagnostics = {
          totalStepsSeen,
          rawStepTypeCounts,
          transformedMessageTypeCounts,
          lastBatchStepTypes,
          lastDelivered,
          hasText,
          fatalSeen,
          cascadeId,
        };
        log.warn(diagnostics, 'empty_response triggered — no text received from Antigravity');
        yield {
          type: 'error',
          catId: this.catId,
          error: 'Antigravity returned no text response',
          errorCode: 'empty_response',
          metadata: { ...metadata, diagnostics },
          timestamp: Date.now(),
        };
      }

      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`invoke failed: ${errorMsg}`);
      yield { type: 'error', catId: this.catId, error: errorMsg, metadata, timestamp: Date.now() };
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    }
  }
}
