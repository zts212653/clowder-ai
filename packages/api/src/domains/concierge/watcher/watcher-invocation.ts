import { createHash } from 'node:crypto';
import { createWatcherNativeBridge } from '@cat-cafe/mcp-server/dist/watcher-native-bridge.js';
import { parseWatcherSessionState } from '@cat-cafe/shared';
import { estimateTokens } from '../../../utils/token-counter.js';
import { createRequestGenerationRecorder } from '../../cats/services/agents/invocation/request-generation-recorder.js';
import { watcherBudgetFailure, watcherBudgetRecovery } from './context/watcher-budget-progress.js';
import { WATCHER_TURN_RESERVE_TOKENS } from './context/watcher-context-budget.js';
import { watcherWindow } from './context/watcher-window.js';
import {
  loadWatcherInvocationSession,
  watcherInvocationAuthority,
  watcherProviderLaunch,
} from './watcher-authority.js';
import { failWatcherAttempt, saveWatcherState } from './watcher-checkpoint.js';
import { finalizeWatcherWake, finishIdleWatcherWake } from './watcher-finalization.js';
import type {
  WatcherInvocationInput,
  WatcherInvocationOwners,
  WatcherRunState,
} from './watcher-invocation-contract.js';
import { watcherNativePort } from './watcher-native-run.js';
import { watcherSystemPrompt } from './watcher-prompt.js';
import { settleWatcherStartupFailure } from './watcher-startup-failure.js';
import { watcherToolSurface } from './watcher-surface.js';

export async function runWatcherInvocation(
  owners: WatcherInvocationOwners,
  input: WatcherInvocationInput,
): Promise<void> {
  const service = input.service.forInvocation?.() ?? input.service;
  const abort = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, abort.signal]) : abort.signal;
  const timer = setTimeout(() => abort.abort(new Error('watcher_deadline_exceeded')), input.deadlineMs ?? 90_000);
  timer.unref?.();
  try {
    for (;;) {
      try {
        await invokeWatcher(owners, { ...input, service, signal });
        break;
      } catch (error) {
        const latest = parseWatcherSessionState((await owners.sessions.get(input.session.id))?.watcherState);
        if (signal.aborted || input.recoveryOnly || !watcherBudgetFailure(error) || !latest.attempt) throw error;
        // The next native admission proves the prior turn idle before shrinking or skipping.
      }
    }
  } finally {
    clearTimeout(timer);
    await service.releaseInvocation?.();
  }
}

async function invokeWatcher(owners: WatcherInvocationOwners, input: WatcherInvocationInput): Promise<void> {
  const { source } = input;
  const current = await loadWatcherInvocationSession(owners.sessions, input.session.id, source, input.signal);
  const state = parseWatcherSessionState(current.watcherState);
  if (await settleWatcherStartupFailure(owners, current, source)) return;
  if (state.attempt?.phase === 'finalize_pending') {
    await finalizeWatcherWake(owners, current, state);
    return;
  }
  if (input.recoveryOnly && !state.attempt) {
    await finishIdleWatcherWake(owners, current, source);
    return;
  }
  if (!state.attempt && state.afterSequence >= source.settledSequence!) return;
  const run: WatcherRunState = {
    session: current,
    state,
    prefixTokens: 0,
    committed: false,
  };
  const service = input.service;
  if (!service.boundedWatcherSessionCapability?.().supported) throw new Error('WATCHER_SESSION_UNSUPPORTED');

  const recovery = run.state.attempt !== undefined;
  const instructions = watcherSystemPrompt(run.session.catId);
  const catalog = watcherToolSurface({});
  const raw = await watcherWindow(owners.messages, source, run.state, instructions, catalog.tools, input.signal);
  const { scopeEnv, configuredSurface, parentInvocationId, auth } = await watcherInvocationAuthority(
    owners,
    run,
    source,
    raw.messageIds,
    input.recoveryOnly,
  );
  run.window = {
    frontier: raw.frontier,
    offset: raw.offset,
    complete: raw.complete,
    messageIds: raw.messageIds,
    tokenBudget: raw.tokenBudget,
    ...(raw.blockedMessageId ? { blockedMessageId: raw.blockedMessageId } : {}),
    ...(raw.resumeCursor ? { resumeCursor: raw.resumeCursor } : {}),
  };
  const abort = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, abort.signal]) : abort.signal;
  let actualSchemas: unknown[] = [];
  let bridge: Awaited<ReturnType<typeof createWatcherNativeBridge>> | undefined;
  let acceptToolCalls!: () => void;
  let rejectToolCalls!: (error: Error) => void;
  const accepted = new Promise<void>((resolve, reject) => {
    acceptToolCalls = resolve;
    rejectToolCalls = reject;
  });
  void accepted.catch(() => undefined);
  const recorder = createRequestGenerationRecorder({
    invocationId: auth.invocationId,
    threadId: source.threadId,
    catId: run.session.catId,
    userId: source.userId,
    transcriptWriter: owners.transcript,
    sessionChainStore: owners.sessions,
    resolveSession: () => owners.sessions.get(run.session.id),
    snapshot: () => ({
      continuity: { capability: 'exact', mode: run.session.cliSessionId ? 'hot' : 'cold', compactionRefs: [] },
      messageSourceRefs: raw.messageIds.map((ref) => ({ owner: 'message' as const, ref })),
      nativeInstructionSourceRefs: [],
      presentations: [],
    }),
  });
  const prompt = `watcherAttemptId=${auth.invocationId}\n工作调用=${source.invocationId}\n工具出声=${input.quiet ? '免打扰，不递话、不提议' : '可由你判断'}\n\n<自己的笔记>\n${run.state.notes}\n</自己的笔记>\n\n<本轮增量>\n${raw.body}\n</本轮增量>\n本轮 frontier=${raw.frontier}:${raw.offset}；sourceMessageId=${source.responseSettlement?.kind === 'message' ? source.responseSettlement.messageId : (source.causal?.triggerMessageId ?? '无回复消息')}。`;
  try {
    if (!recovery)
      run.state = await saveWatcherState(owners.sessions, run.session.id, run.state, {
        wakeInvocationId: auth.invocationId,
        ...(run.state.wakeInvocationId !== auth.invocationId
          ? { rawWindowTokens: undefined, directoryReads: undefined, skippedWindows: undefined }
          : {}),
        attempt: {
          invocationId: auth.invocationId,
          sourceInvocationId: source.invocationId,
          sourceSequence: source.settledSequence!,
          startedAt: Date.now(),
          phase: 'running',
          window: run.window,
        },
      });
    if (!recovery && raw.messageIds.length === 0 && raw.blockedMessageId) {
      const execution = await owners.executions.get(auth.invocationId);
      if (!execution || (execution.providerStartedAt !== undefined && execution.providerTeardownAt === undefined))
        throw new Error('watcher_unadmitted_window_proof_missing');
      // No native provider was launched for this empty window. The original is retained in the skip audit.
      run.state = await saveWatcherState(
        owners.sessions,
        run.session.id,
        run.state,
        await watcherBudgetRecovery(owners, run.session, run.state, run.window),
      );
      run.committed = true;
      return;
    }
    bridge = await createWatcherNativeBridge({
      credentials: {
        invocationId: auth.invocationId,
        callbackToken: auth.callbackToken,
        apiUrl: owners.apiUrl,
        catId: run.session.catId,
        threadId: source.threadId,
        userId: source.userId,
        authorizeTool: async (toolName) => {
          const verified = await owners.registry.verify(auth.invocationId, auth.callbackToken);
          if (!verified.ok) throw new Error('Watcher invocation no longer active');
          if (
            [
              'cat_cafe_watcher_nudge',
              'cat_cafe_offer_suggestion',
              'cat_cafe_post_action_receipt',
              'cat_cafe_bring_to_desk',
            ].includes(toolName) &&
            !(await owners.maySpeak(source.userId, source.threadId, run.session.catId))
          )
            throw new Error('Watcher is quiet; keep the source in your own notes');
        },
      },
      allowedToolNames: configuredSurface.policy.mode === 'watcher' ? configuredSurface.policy.allowedToolNames : [],
      admit: (callId, toolName) => owners.registry.consumeWatcherToolCall(auth.invocationId, callId, toolName),
    });
    actualSchemas = JSON.parse(
      JSON.stringify(
        bridge.tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
        })),
      ),
    );
    const schemaHash = createHash('sha256').update(JSON.stringify(actualSchemas)).digest('hex');
    if (run.state.toolSchemaHash && run.state.toolSchemaHash !== schemaHash)
      throw new Error('watcher_native_tool_surface_changed');
    if (!run.state.toolSchemaHash)
      run.state = await saveWatcherState(owners.sessions, run.session.id, run.state, { toolSchemaHash: schemaHash });
    const { workspace, binding, callbackEnv } = await watcherProviderLaunch(
      owners.threads,
      run.session.catId,
      source,
      scopeEnv,
      signal,
    );
    await owners.executions.markProviderStarted(auth.invocationId, Date.now());
    for await (const message of service.invoke(prompt, {
      invocationId: auth.invocationId,
      hostSessionId: run.session.id,
      sessionId: run.session.cliSessionId,
      requireExactResume: Boolean(run.session.cliSessionId),
      nativeSessionBinding: run.session.nativeSessionBinding,
      workingDirectory: workspace.workingDirectory,
      callbackEnv,
      ...(binding.codexAccountLaunch ? { codexAccountLaunch: binding.codexAccountLaunch } : {}),
      ...(binding.executionAccount ? { executionAccount: binding.executionAccount } : {}),
      signal,
      toolExecutionPolicy: configuredSurface.policy,
      requiredTools: configuredSurface.requiredTools,
      auditContext: {
        invocationId: auth.invocationId,
        executionId: parentInvocationId,
        threadId: source.threadId,
        userId: source.userId,
        catId: run.session.catId,
      },
      beforeProviderLaunch: async (prepared) => {
        if (!('body' in prepared.message)) throw new Error('watcher_request_body_unknown');
        run.prefixTokens = estimateTokens(
          JSON.stringify({
            body: prepared.message.body,
            instructions: prepared.nativeInstructions,
            schemas: actualSchemas,
          }),
        );
        if (run.prefixTokens + WATCHER_TURN_RESERVE_TOKENS > 30_000) throw new Error('watcher_context_budget_exceeded');
        run.generation = await recorder.recordPrepared(
          {
            ...prepared,
            tools: { ...prepared.tools, finalSurface: 'exact', declaredServerNames: [], catCafeSchemas: actualSchemas },
          },
          { attempt: 1 },
        );
        return run.generation!;
      },
      boundedWatcher: watcherNativePort({
        owners,
        run,
        bridge,
        surface: configuredSurface,
        instructions,
        signal,
        recovery,
        recoveryOnly: input.recoveryOnly === true,
        accepted,
        acceptToolCalls,
        abort: (error) => abort.abort(error),
        recorder,
      }),
    })) {
      if (message.type === 'session_init' && message.sessionId) {
        const bound =
          run.session.cliSessionId === message.sessionId
            ? run.session
            : await owners.sessions.bindCliSessionIdIfUnbound(run.session.id, message.sessionId);
        if (!bound || bound.cliSessionId !== message.sessionId) throw new Error('watcher_native_session_replaced');
        run.session = bound;
        if (message.nativeSessionBinding)
          run.session =
            (await owners.sessions.update(run.session.id, { nativeSessionBinding: message.nativeSessionBinding })) ??
            run.session;
      }
      await owners.transcript.appendDurableEvent(
        {
          sessionId: run.session.id,
          threadId: source.threadId,
          catId: run.session.catId,
          cliSessionId: run.session.cliSessionId,
          seq: run.session.seq,
        },
        message as unknown as Record<string, unknown>,
        auth.invocationId,
      );
      if (message.type === 'error') throw new Error(message.error ?? message.content ?? 'watcher_provider_failed');
    }
    // A native-only probe can prove an old failure terminal without producing a checkpoint.
    if (!run.committed && !(input.recoveryOnly && run.recoveredIdle && !run.state.attempt))
      throw new Error('watcher_checkpoint_not_committed');
  } catch (error) {
    throw await failWatcherAttempt(owners, run, auth.invocationId, error, signal);
  } finally {
    rejectToolCalls(new Error('Watcher invocation closed'));
    await bridge?.close().catch(() => undefined);
    await run.boundary?.close().catch(() => undefined);
    if (run.generation)
      await recorder
        .recordTerminal(
          run.generation,
          run.committed ? 'accepted' : 'error',
          run.committed ? undefined : 'watcher_checkpoint_not_committed',
        )
        .catch(() => undefined);
    if (!recovery || run.nativeTurnAdmitted || run.recoveredIdle)
      await Promise.resolve(owners.executions.recordProviderTeardown(auth.invocationId, Date.now())).catch(
        () => undefined,
      );
    const failedSession = await owners.sessions.get(run.session.id);
    const startupSettled = failedSession && (await settleWatcherStartupFailure(owners, failedSession, source));
    // An incomplete or partial window retains this exact auth and its six durable tickets.
    // Only the logical source outcome terminalizes it; a recovery-only RPC is not a model attempt.
    if (!startupSettled && run.committed && run.state.afterSequence >= source.settledSequence!) {
      run.state = await finalizeWatcherWake(owners, run.session, run.state);
    } else if (!startupSettled && input.recoveryOnly && !run.state.attempt) {
      run.state = await finishIdleWatcherWake(owners, run.session, source);
    } else if (
      !startupSettled &&
      (!recovery || run.nativeTurnAdmitted || run.recoveredIdle) &&
      signal.aborted &&
      ['watcher_disabled', 'watcher_supervisor_stopped'].includes(
        signal.reason instanceof Error ? signal.reason.message : '',
      )
    ) {
      await owners.executions.transitionTerminal(auth.invocationId, {
        status: 'canceled',
        endedAt: Date.now(),
        terminalReason: 'watcher_control_stopped',
        providerTeardownAt: Date.now(),
      });
      await owners.executions.markResponseSettled(auth.invocationId, {
        kind: 'no_response',
        reason: 'tool_only',
        settledAt: Date.now(),
      });
    }
  }
}
