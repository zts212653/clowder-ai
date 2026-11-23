import type { CatId } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../../../infrastructure/logger.js';
import type { spawnCli } from '../../../../../../../utils/cli-spawn.js';
import type { AgentMessage, AgentServiceOptions, MessageMetadata } from '../../../../types.js';
import { type RawArchiveSink, sanitizeRawEvent } from '../../codex-audit-hooks.js';
import type { createAgyNativeContinuityInput } from '../agy-native-continuity.js';
import type { AgyNativeLaunchPlan } from '../agy-native-launch.js';
import { AgyNativeProgress } from '../agy-native-progress.js';
import { asRecord } from '../agy-native-stream-validation.js';
import { type AgyNativeObservedTurn, observeAgyNativeTurn, projectAgyNativeTurn } from '../agy-native-turn.js';
import { AgyNativeCapacityObserver } from './agy-native-capacity-observer.js';
import { AgyNativeImagePublisher } from './agy-native-image-publisher.js';
import { recoverAgyNativeMcpSpill } from './agy-native-mcp-spill.js';
import { AgyNativeRunInput } from './agy-native-run-input.js';
import { AgyNativeRunOutput } from './agy-native-run-output.js';

const log = createModuleLogger('agy-native');
/**
 * On Windows, `agy.exe --input-format stream-json` ignores stdin EOF after emitting
 * its terminal `result` event and lingers until terminated. Allow a brief grace window
 * for natural (clean or non-zero) exit before terminating the owned process.
 */
const WINDOWS_POST_EOF_EXIT_GRACE_MS = 2_000;

async function* archiveNativeStream(
  stream: AsyncIterable<unknown>,
  invocationId: string | undefined,
  archive: RawArchiveSink,
  observeNativeEvent: (eventType: string) => void,
) {
  for await (const event of stream) {
    if (event && typeof event === 'object' && 'event' in event && typeof event.event === 'string')
      observeNativeEvent(event.event);
    if (invocationId) {
      try {
        await archive.append(invocationId, sanitizeRawEvent(event));
      } catch (error) {
        log.warn({ invocationId, error }, 'Native raw archive write failed');
      }
    }
    yield event;
  }
}

/** One owned process, verified turn boundaries and cleanup before host terminal release. */
export async function* runAgyNativeInvocation(input: {
  catId: CatId;
  model: string;
  prompt: string;
  launch: AgyNativeLaunchPlan;
  metadata: MessageMetadata;
  rawArchive: RawArchiveSink;
  spawnCliFn: typeof spawnCli;
  options?: AgentServiceOptions;
  continuityInput?: ReturnType<typeof createAgyNativeContinuityInput>;
  compactionRequested: boolean;
  rawArchivePath?: string;
}): AsyncGenerator<AgentMessage> {
  const {
    catId,
    model,
    prompt,
    launch,
    metadata,
    rawArchive,
    spawnCliFn,
    options,
    continuityInput,
    compactionRequested,
    rawArchivePath,
  } = input;
  const inputLifetime = new AbortController();
  const processLifetime = new AbortController();
  let windowsPostEofTimer: ReturnType<typeof setTimeout> | undefined;
  let windowsPostEofTriggered = false;
  let resultBoundaryObserved = false;
  const armWindowsPostEofShutdown = (): void => {
    if (process.platform !== 'win32' || windowsPostEofTimer || !resultBoundaryObserved || options?.signal?.aborted) {
      return;
    }
    windowsPostEofTimer = setTimeout(() => {
      if (options?.signal?.aborted) return;
      windowsPostEofTriggered = true;
      log.info(
        { catId, invocationId: options?.invocationId, graceMs: WINDOWS_POST_EOF_EXIT_GRACE_MS },
        'Terminating lingering Windows AGY native process after terminal result EOF',
      );
      processLifetime.abort();
    }, WINDOWS_POST_EOF_EXIT_GRACE_MS);
    windowsPostEofTimer.unref();
  };
  inputLifetime.signal.addEventListener('abort', armWindowsPostEofShutdown, { once: true });
  const multiTurn = Boolean(options?.activeRunDispatch && !compactionRequested && prompt.trim() !== '/compact');
  const imagePublisher = new AgyNativeImagePublisher(
    catId,
    metadata,
    launch.binding.profileHome,
    launch.agentTools,
    options?.uploadDir,
  );
  let runInput: AgyNativeRunInput | undefined;
  let automaticCheckpoint = !compactionRequested && !/^\/compact(?:\s|$)/.test(prompt.trim());
  if (multiTurn && options)
    runInput = new AgyNativeRunInput(
      options,
      () => inputLifetime.abort(),
      launch.binding.workspaceRoot,
      (text) => {
        automaticCheckpoint = !/^\/compact(?:\s|$)/.test(text.trim());
      },
      launch.supplementalUploadDir,
    );
  try {
    const { stdinInput, ...deferredLaunchOptions } = launch.cliOptions;
    const cliOptions = {
      ...deferredLaunchOptions,
      ...(runInput
        ? {
            onStdinReady: (write: (input: string) => void) => {
              runInput?.onStdinReady(write);
              if (continuityInput) continuityInput.onStdinReady(write);
              else if (stdinInput) write(stdinInput);
            },
          }
        : continuityInput
          ? { onStdinReady: continuityInput.onStdinReady }
          : { stdinInput }),
      signal: options?.signal ? AbortSignal.any([options.signal, processLifetime.signal]) : processLifetime.signal,
      stdinCloseSignal: inputLifetime.signal,
      rawArchivePath,
    };
    const stream = options?.spawnCliOverride ? options.spawnCliOverride(cliOptions) : spawnCliFn(cliOptions);
    const progress = new AgyNativeProgress(catId, metadata);
    let lastNativeEventType: string | undefined;
    let lastNativeStep:
      | { stepIndex: number; stepType: string; toolName: string | null; state: string; firstObservedAt: number }
      | undefined;
    let runOutput: AgyNativeRunOutput | undefined;
    let observed: AgyNativeObservedTurn | undefined;
    let capacityObserver: AgyNativeCapacityObserver | undefined;
    const successful = (messages: readonly AgentMessage[]) =>
      messages.at(-1)?.type === 'done' && messages.at(-1)?.errorCode === undefined;
    const settleCapacity = (turn: AgyNativeObservedTurn, hostSuccessful: boolean) => {
      try {
        const observation = capacityObserver?.commit(
          automaticCheckpoint &&
            hostSuccessful &&
            turn.turn.stepsComplete &&
            !turn.transportError &&
            !turn.cancelledBeforeTerminal,
        );
        if (observation) metadata.contextWindowObservation = observation;
      } catch (error) {
        log.warn({ error }, 'Native AGY checkpoint capacity evidence could not be persisted');
      }
    };
    for await (const observation of observeAgyNativeTurn(
      archiveNativeStream(stream, options?.invocationId, rawArchive, (eventType) => {
        lastNativeEventType = eventType;
        if (eventType === 'result') {
          resultBoundaryObserved = true;
          if (runInput) runInput.resultBoundary();
          else inputLifetime.abort();
        }
      }),
      {
        agentName: launch.agentName,
        spawnCwd: launch.cliOptions.cwd,
        model: model,
        permissionMode: launch.permissionMode,
        command: launch.cliOptions.command,
        ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
        ...(launch.resumeSessionId ? { sessionId: launch.resumeSessionId } : {}),
      },
      options?.signal,
      multiTurn,
    )) {
      if (observation.kind === 'init') {
        await launch.bindSession(observation.sessionId);
        await continuityInput?.acceptVerifiedInit(observation.sessionId);
        metadata.sessionId = observation.sessionId;
        metadata.model = model;
        if (launch.capacityScope) {
          capacityObserver = new AgyNativeCapacityObserver(launch.capacityScope, observation.sessionId);
          metadata.contextWindowObservation = capacityObserver.current;
        }
        if (runInput) runOutput = new AgyNativeRunOutput(catId, metadata, launch.agentTools);
        runInput?.register(observation.sessionId);
        yield {
          type: 'session_init',
          catId: catId,
          sessionId: observation.sessionId,
          nativeSessionBinding: { ...launch.binding, cliSessionId: observation.sessionId },
          metadata,
          timestamp: Date.now(),
        };
      } else if (observation.kind === 'step') {
        const event = observation.event;
        capacityObserver?.step(event, automaticCheckpoint);
        lastNativeStep = {
          stepIndex: event.stepIndex,
          stepType: event.stepType,
          toolName: event.toolName,
          state: event.state,
          firstObservedAt: lastNativeStep?.stepIndex === event.stepIndex ? lastNativeStep.firstObservedAt : Date.now(),
        };
        await runInput?.step(observation.event);
        const messages = runOutput ? runOutput.step(observation.event) : progress.step(observation.event);
        for (const message of messages) {
          yield await recoverAgyNativeMcpSpill(
            message,
            observation.event,
            launch.binding.profileHome,
            launch.agentTools,
          );
        }
      } else if (observation.kind === 'result') {
        const resultObserved =
          runInput?.hasUnconfirmedInput && observation.observed.turn.outcome === 'ok'
            ? {
                ...observation.observed,
                transportError:
                  observation.observed.transportError ??
                  'AGY native result arrived before its user input was confirmed read',
              }
            : observation.observed;
        const publication = await imagePublisher.settle(resultObserved);
        yield* publication.messages;
        if (runInput && runOutput) {
          const messages = runOutput.result(publication.observed);
          runInput.observeResult(runOutput.successful);
          if (!runOutput.successful) {
            processLifetime.abort();
            observed = publication.observed;
            yield* messages;
            break;
          }
          yield* messages;
        }
      } else if (observation.kind === 'turn_complete') {
        resultBoundaryObserved = false;
        const projected = projectAgyNativeTurn(
          catId,
          { ...metadata },
          observation.observed,
          observation.observed.cancelledBeforeTerminal === true,
          launch.agentTools,
        );
        const hostSuccessful = successful(projected);
        await runInput?.completeTurn(hostSuccessful);
        settleCapacity(observation.observed, hostSuccessful);
        if (!hostSuccessful) {
          observed = observation.observed;
          processLifetime.abort();
          break;
        }
      } else if (observation.kind === 'liveness') {
        const warning = lastNativeStep
          ? {
              ...observation.warning,
              ...(lastNativeEventType === 'step_update' && observation.warning.lastEventType == null
                ? { lastEventType: 'step_update' }
                : {}),
              lastNativeStep,
            }
          : observation.warning;
        log.warn(
          {
            catId: catId,
            invocationId: options?.invocationId,
            level: observation.warning.level,
            silenceMs: observation.warning.silenceDurationMs,
            ...(lastNativeStep ? { lastNativeStep } : {}),
          },
          'Native AGY liveness warning',
        );
        yield {
          type: 'system_info',
          catId: catId,
          metadata,
          timestamp: Date.now(),
          content: JSON.stringify({ type: 'liveness_warning', ...warning }),
        };
      } else {
        observed = observation.observed;
      }
    }
    if (!observed) throw new Error('AGY native stream ended without a terminal observation');
    if (windowsPostEofTriggered) {
      metadata.diagnostics = {
        ...metadata.diagnostics,
        agyNative: {
          ...asRecord(metadata.diagnostics?.agyNative),
          windowsPostEofShutdown: {
            triggered: true,
            graceMs: WINDOWS_POST_EOF_EXIT_GRACE_MS,
          },
        },
      };
    }
    const publication = await imagePublisher.settle(observed);
    observed = publication.observed;
    yield* publication.messages;
    if (runInput && runOutput) {
      if (runInput.hasUnfinishedInput) {
        log.warn(
          { catId, invocationId: options?.invocationId, upstreamOutcome: observed.turn.outcome },
          'Native run ended with unfinished supplemental inputs',
        );
        observed = {
          ...observed,
          // A missing supplemental result cannot replace the failed turn's actual provider diagnosis.
          transportError:
            observed.transportError ??
            (runOutput.successful ? 'AGY native process ended before an accepted input completed' : null),
          cancelledBeforeTerminal: options?.signal?.aborted === true || observed.cancelledBeforeTerminal,
        };
      }
      const messages = runOutput.finish(observed);
      await runInput.completeTurn(successful(messages));
      await runInput.dispose();
      settleCapacity(observed, successful(messages));
      for (const message of messages) {
        if (message.metadata) {
          message.metadata.contextWindowObservation = metadata.contextWindowObservation;
          if (windowsPostEofTriggered) {
            message.metadata.diagnostics = {
              ...message.metadata.diagnostics,
              agyNative: {
                ...asRecord(message.metadata.diagnostics?.agyNative),
                windowsPostEofShutdown: {
                  triggered: true,
                  graceMs: WINDOWS_POST_EOF_EXIT_GRACE_MS,
                },
              },
            };
          }
        }
      }
      yield* messages;
      return;
    }
    const messages = projectAgyNativeTurn(
      catId,
      metadata,
      observed,
      observed.cancelledBeforeTerminal === true,
      launch.agentTools,
      compactionRequested,
    );
    settleCapacity(observed, successful(messages));
    yield* progress.final(messages);
  } finally {
    if (windowsPostEofTimer) clearTimeout(windowsPostEofTimer);
    inputLifetime.signal.removeEventListener('abort', armWindowsPostEofShutdown);
    processLifetime.abort();
    await runInput?.dispose();
  }
}
