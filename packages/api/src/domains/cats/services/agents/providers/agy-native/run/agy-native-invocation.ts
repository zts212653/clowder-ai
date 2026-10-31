import type { CatId } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../../../infrastructure/logger.js';
import type { spawnCli } from '../../../../../../../utils/cli-spawn.js';
import type { AgentMessage, AgentServiceOptions, MessageMetadata } from '../../../../types.js';
import { type RawArchiveSink, sanitizeRawEvent } from '../../codex-audit-hooks.js';
import type { createAgyNativeContinuityInput } from '../agy-native-continuity.js';
import type { AgyNativeLaunchPlan } from '../agy-native-launch.js';
import { AgyNativeProgress } from '../agy-native-progress.js';
import { type AgyNativeObservedTurn, observeAgyNativeTurn, projectAgyNativeTurn } from '../agy-native-turn.js';
import { recoverAgyNativeMcpSpill } from './agy-native-mcp-spill.js';
import { AgyNativeRunInput } from './agy-native-run-input.js';
import { AgyNativeRunOutput } from './agy-native-run-output.js';

const log = createModuleLogger('agy-native');

async function* archiveNativeStream(
  stream: AsyncIterable<unknown>,
  invocationId: string | undefined,
  archive: RawArchiveSink,
  closeInput: () => void,
) {
  for await (const event of stream) {
    if (event && typeof event === 'object' && 'event' in event && event.event === 'result') closeInput();
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
  const multiTurn = Boolean(options?.activeRunDispatch && !compactionRequested && prompt.trim() !== '/compact');
  let runInput: AgyNativeRunInput | undefined;
  if (multiTurn && options) runInput = new AgyNativeRunInput(options, () => inputLifetime.abort());
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
    let runOutput: AgyNativeRunOutput | undefined;
    let observed: AgyNativeObservedTurn | undefined;
    for await (const observation of observeAgyNativeTurn(
      archiveNativeStream(stream, options?.invocationId, rawArchive, () => {
        if (runInput) runInput.resultBoundary();
        else inputLifetime.abort();
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
        if (runInput && runOutput) {
          const messages = runOutput.result(observation.observed);
          await runInput.result(runOutput.successful);
          if (!runOutput.successful) {
            processLifetime.abort();
            observed = observation.observed;
            yield* messages;
            break;
          }
          yield* messages;
        }
      } else if (observation.kind === 'liveness') {
        log.warn(
          {
            catId: catId,
            invocationId: options?.invocationId,
            level: observation.warning.level,
            silenceMs: observation.warning.silenceDurationMs,
          },
          'Native AGY liveness warning',
        );
        yield {
          type: 'system_info',
          catId: catId,
          metadata,
          timestamp: Date.now(),
          content: JSON.stringify({ type: 'liveness_warning', ...observation.warning }),
        };
      } else observed = observation.observed;
    }
    if (!observed) throw new Error('AGY native stream ended without a terminal observation');
    if (runInput && runOutput) {
      if (runInput.hasUnfinishedInput)
        observed = {
          ...observed,
          transportError: observed.transportError ?? 'AGY native process ended before an accepted input completed',
          cancelledBeforeTerminal: options?.signal?.aborted === true || observed.cancelledBeforeTerminal,
        };
      await runInput.dispose();
      yield* runOutput.finish(observed);
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
    yield* progress.final(messages);
  } finally {
    processLifetime.abort();
    await runInput?.dispose();
  }
}
