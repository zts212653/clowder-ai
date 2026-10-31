import type { AgentServiceOptions, ProviderContinuityPreflight } from '../../../types.js';
import { encodeAgyStreamJsonUserMessage } from '../agy-stream-json-parser.js';
import { prepareAgyNativeInput } from './agy-native-input.js';
import type { AgyNativeLaunchPlan } from './agy-native-launch.js';

/** One prompt generation, delivered only after the caller verified native init. */
export function createAgyNativeContinuityInput(
  launch: AgyNativeLaunchPlan,
  preflight: ProviderContinuityPreflight,
  options?: AgentServiceOptions,
) {
  let writer: ((input: string) => void) | undefined;
  let settled = false;
  return {
    onStdinReady(write: (input: string) => void) {
      writer = write;
    },
    async acceptVerifiedInit(runtimeSessionId: string): Promise<void> {
      if (settled || !writer) throw new Error('Native continuity input owner unavailable');
      settled = true;
      const generation = await preflight.settle({
        evidence: launch.resumeSessionId
          ? { kind: 'resumed', requestedRuntimeSessionId: launch.resumeSessionId, runtimeSessionId }
          : { kind: 'started', runtimeSessionId },
        compactions: [],
      });
      options?.signal?.throwIfAborted();
      const input = prepareAgyNativeInput(
        generation.prompt,
        options?.contentBlocks,
        launch.binding.workspaceRoot,
        options?.uploadDir,
      );
      const message = launch.preparedRequest.message;
      if (!('body' in message)) throw new Error('Native launch omitted its exact input contract');
      await options?.beforeProviderLaunch?.({
        ...launch.preparedRequest,
        message: { ...message, body: input.prompt },
      });
      options?.signal?.throwIfAborted();
      writer(`${encodeAgyStreamJsonUserMessage(input.prompt)}\n`);
    },
  };
}
