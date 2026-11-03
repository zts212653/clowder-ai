import { DEFAULT_PROFILE_USER_ID } from '@cat-cafe/shared/profile-contract';
import { captureInvocationL0Input } from '../../cats/services/agents/providers/l0-input-capture.js';
import type { AgentMessage, AgentServiceOptions, TokenUsage } from '../../cats/services/types.js';
import type { CurationProvider } from '../LunaCurationClient.js';

export interface LunaNativeRun {
  text: string;
  success: boolean;
  sessionId?: string;
  usage?: TokenUsage;
  modelId: string;
  elapsedMs: number;
}

/** Native carrier owns authentication and transport; each consumer owns its session. */
export async function runLunaNative(input: {
  userId?: string;
  provider: CurationProvider;
  prompt: string;
  instructions: string;
  workingDirectory: string;
  signal?: AbortSignal;
  sessionId?: string;
}): Promise<LunaNativeRun> {
  const started = Date.now();
  const state: LunaNativeRun = { text: '', success: false, modelId: input.provider.model, elapsedMs: 0 };
  let failed = false;
  let observedResponse = false;
  const userId = input.userId ?? input.provider.options?.callbackEnv?.CAT_CAFE_USER_ID ?? DEFAULT_PROFILE_USER_ID;
  const frozenL0Input =
    input.provider.options?.frozenL0Input ??
    (input.provider.catConfig
      ? captureInvocationL0Input({
          catId: input.provider.catId,
          catConfig: input.provider.catConfig,
          userId,
          model: input.provider.model,
        })
      : undefined);
  const options: AgentServiceOptions = {
    ...input.provider.options,
    ...(frozenL0Input ? { frozenL0Input } : {}),
    callbackEnv: { ...input.provider.options?.callbackEnv, CAT_CAFE_USER_ID: userId },
    workingDirectory: input.workingDirectory,
    systemPrompt: input.instructions,
    toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
    ...(input.signal ? { signal: input.signal } : {}),
  };
  // A librarian must never inherit a provider's source-thread session option.
  delete options.sessionId;
  if (input.sessionId) options.sessionId = input.sessionId;
  try {
    for await (const message of input.provider.service.invoke(input.prompt, options)) {
      observe(message);
    }
  } catch {
    failed = true;
  } finally {
    state.elapsedMs = Date.now() - started;
  }
  state.success &&= !failed && state.text.trim().length > 0;
  // A resumed carrier can report the previous token_count on cancellation.
  // That describes stored context, not spend for this attempt.
  if (input.sessionId && !observedResponse && !state.text.trim()) delete state.usage;
  return state;

  function observe(message: AgentMessage) {
    if (message.type === 'text')
      state.text = message.textMode === 'replace' ? (message.content ?? '') : state.text + (message.content ?? '');
    if (message.type === 'error' && message.errorDisposition !== 'transient') failed = true;
    if (message.sessionId) state.sessionId = message.sessionId;
    if (message.metadata?.sessionId) state.sessionId = message.metadata.sessionId;
    if (message.metadata?.usage) state.usage = message.metadata.usage;
    if (message.metadata?.model) state.modelId = message.metadata.model;
    if (message.metadata?.servedResponseId) observedResponse = true;
    if (message.type === 'done') {
      state.success = true;
      failed ||= Boolean(message.errorCode);
    }
  }
}
