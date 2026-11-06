import type { createWatcherNativeBridge } from '@cat-cafe/mcp-server/dist/watcher-native-bridge.js';
import { parseWatcherSessionState, type WatcherUsage } from '@cat-cafe/shared';
import { estimateTokens } from '../../../utils/token-counter.js';
import type { createRequestGenerationRecorder } from '../../cats/services/agents/invocation/request-generation-recorder.js';
import type { BoundedWatcherRunPort } from '../../cats/services/agents/providers/BoundedWatcherRunPort.js';
import { asCodexAppServerRecord } from '../../cats/services/agents/providers/CodexAppServerEventMapper.js';
import { commitWatcherCheckpoint, recoverWatcherAttempt, saveWatcherState } from './watcher-checkpoint.js';
import { boundedWatcherResult } from './watcher-context-budget.js';
import type { WatcherInvocationOwners, WatcherRunState } from './watcher-invocation-contract.js';
import { watcherProviderOverrides } from './watcher-provider-config.js';
import { createWatcherRequestBoundary } from './watcher-request-boundary.js';
import type { watcherToolSurface } from './watcher-surface.js';

/** The native role is admitted once, checkpointed durably, then pruned while its exact owner is held. */
export function watcherNativePort(input: {
  owners: WatcherInvocationOwners;
  run: WatcherRunState;
  bridge: Awaited<ReturnType<typeof createWatcherNativeBridge>>;
  surface: ReturnType<typeof watcherToolSurface>;
  instructions: string;
  signal: AbortSignal;
  recovery: boolean;
  recoveryOnly?: boolean;
  accepted: Promise<void>;
  acceptToolCalls(): void;
  abort(error: Error): void;
  recorder: ReturnType<typeof createRequestGenerationRecorder>;
}): BoundedWatcherRunPort {
  const { owners, run, bridge, surface, instructions, signal, recovery, accepted, acceptToolCalls, recorder } = input;
  let calls = 0;
  return {
    configureProvider: async ({ config, account, transportEnv }) => {
      const id = typeof config.model_provider === 'string' ? config.model_provider : 'openai';
      const provider = asCodexAppServerRecord(asCodexAppServerRecord(config.model_providers)?.[id]);
      const ownedOpenai = id === 'openai' || id === 'openai_https';
      const upstream =
        typeof provider?.base_url === 'string'
          ? provider.base_url
          : ownedOpenai && account?.type === 'chatgpt'
            ? 'https://chatgpt.com/backend-api/codex'
            : ownedOpenai && account?.type === 'apiKey'
              ? 'https://api.openai.com/v1'
              : undefined;
      if (!upstream) throw new Error('watcher_native_provider_endpoint_unavailable');
      run.boundary = await createWatcherRequestBoundary(upstream, {
        signal,
        transportEnv,
        observed: async (row) => {
          await accepted;
          await owners.transcript.appendDurableEvent(
            {
              sessionId: run.session.id,
              threadId: run.session.threadId,
              catId: run.session.catId,
              seq: run.session.seq,
              cliSessionId: run.session.cliSessionId,
            },
            { type: 'watcher_context_bound', ...row },
            run.state.attempt!.invocationId,
          );
          if (
            !(await owners.executions.recordWatcherModelAttempt(
              run.state.attempt!.invocationId,
              `${run.state.attempt!.nativeTurnId}:${row.request}`,
              Date.now(),
            ))
          )
            throw new Error('watcher_model_attempt_not_durable');
        },
        completed: async (row, usage) => {
          if (
            !(await owners.executions.recordWatcherModelAttempt(
              run.state.attempt!.invocationId,
              `${run.state.attempt!.nativeTurnId}:${row.request}`,
              Date.now(),
              usage,
            ))
          )
            throw new Error('watcher_model_usage_not_durable');
        },
      });
      return {
        model_provider: id,
        model_providers: {
          [id]: {
            ...watcherProviderOverrides(
              provider ?? { name: 'OpenAI', wire_api: 'responses', requires_openai_auth: true },
            ),
            base_url: run.boundary.baseUrl,
            supports_websockets: false,
            request_max_retries: 0,
            stream_max_retries: 0,
          },
        },
        features: { enable_request_compression: false },
      };
    },
    instructions,
    config: surface.config,
    tools: bridge.tools,
    callTool: async (params) => {
      await accepted;
      if (
        params.threadId !== run.session.cliSessionId ||
        params.turnId !== run.state.attempt?.nativeTurnId ||
        typeof params.tool !== 'string' ||
        typeof params.callId !== 'string'
      )
        throw new Error('Watcher native tool scope mismatch');
      if (++calls > 7 || estimateTokens(JSON.stringify(params.arguments) ?? '') > 1200) {
        await owners.registry.consumeWatcherToolCall(
          run.state.attempt!.invocationId,
          `native:${params.callId}`,
          params.tool,
        );
        const error = new Error('watcher_tool_or_argument_budget_exhausted');
        input.abort(error);
        throw error;
      }
      // The first denied request must still let the model write its final checkpoint.
      // A repeated attempt ends this wake; no seventh MCP call is ever admitted.
      if (calls > 6 || (await owners.registry.watcherToolCallCount(run.state.attempt!.invocationId)) >= 6) {
        const firstDenial = await owners.registry.claimClientMessageId(
          run.state.attempt!.invocationId,
          'watcher-native-budget-denial:v1',
        );
        if (!firstDenial) input.abort(new Error('watcher_repeated_tool_budget_denial'));
        throw new Error('watcher_tool_budget_exhausted: 请直接输出最终 checkpoint');
      }
      const result = await bridge.call(params.tool, params.arguments, `native:${params.callId}`, signal);
      await owners.transcript.appendDurableEvent(
        {
          sessionId: run.session.id,
          threadId: run.session.threadId,
          catId: run.session.catId,
          cliSessionId: run.session.cliSessionId,
          seq: run.session.seq,
        },
        {
          type: 'watcher_tool_receipt',
          callId: params.callId,
          tool: params.tool,
          result,
        },
        run.state.attempt!.invocationId,
      );
      return {
        success: result.isError !== true,
        contentItems: [{ type: 'inputText', text: boundedWatcherResult(result, String(params.callId)) }],
      };
    },
    outputSchema: {
      type: 'object',
      properties: {
        v: { type: 'integer', const: 1 },
        notes: { type: 'string' },
        consumedThrough: { type: 'string' },
        outcome: { type: 'string', enum: ['quiet', 'remembered', 'nudged', 'proposed'] },
      },
      required: ['v', 'notes', 'consumedThrough', 'outcome'],
      additionalProperties: false,
    },
    beforeTurn: async ({ threadId, client }) => {
      run.session = (await owners.sessions.get(run.session.id))!;
      if (!run.session || run.session.cliSessionId !== threadId) throw new Error('watcher_native_binding_mismatch');
      if (recovery) {
        const active = parseWatcherSessionState(run.session.watcherState);
        run.state = await recoverWatcherAttempt(owners, run.session, active, client, input.recoveryOnly !== true);
        run.recoveredIdle = true;
        if (run.state.attempt?.phase === 'finalize_pending') {
          run.committed = true;
          return false;
        }
        if (!run.state.attempt) {
          run.committed = ['running', 'succeeded'].includes(
            (await owners.executions.get(active.attempt!.invocationId))?.status ?? '',
          );
          return false;
        }
        return true;
      }
      return true;
    },
    accepted: async ({ threadId, turnId }) => {
      if (run.session.cliSessionId !== threadId || !run.state.attempt)
        throw new Error('watcher_native_binding_mismatch');
      run.nativeTurnAdmitted = true;
      run.state = await saveWatcherState(owners.sessions, run.session.id, run.state, {
        attempt: { ...run.state.attempt, nativeTurnId: turnId },
      });
      acceptToolCalls();
      if (run.generation)
        await recorder.recordObserved(run.generation, {
          evidenceRef: `native-turn:${turnId}`,
          runtimeSessionId: threadId,
        });
    },
    completed: async ({ client, usage }) => {
      run.boundary?.assertHealthy();
      const rawUsage = asCodexAppServerRecord(usage);
      const actualUsage: WatcherUsage = {
        reportedAt: Date.now(),
        prefixTokens: run.prefixTokens,
        ...(run.boundary ? { workingContextTokens: run.boundary.maximum() } : {}),
        ...(typeof rawUsage?.input_tokens === 'number' ? { inputTokens: rawUsage.input_tokens } : {}),
        ...(typeof rawUsage?.output_tokens === 'number' ? { outputTokens: rawUsage.output_tokens } : {}),
        ...(typeof rawUsage?.cached_input_tokens === 'number' ? { cacheReadTokens: rawUsage.cached_input_tokens } : {}),
      };
      run.state = await commitWatcherCheckpoint(owners, run.session, run.state, client, actualUsage);
      run.committed = true;
    },
  };
}
