import { writeFileSync } from 'node:fs';
import type { AgentServiceOptions } from '../../types.js';

export interface NativeSessionPromptRequest {
  catId: string;
  userId?: string;
  outPath?: string;
}

/** Test-only seam retained by provider unit tests; production supplies pipeline bytes. */
export type NativeSessionPromptTestFactory = (request: NativeSessionPromptRequest) => Promise<string>;

/**
 * Validate the route-owned HookPipeline result at the provider boundary.
 * Providers transport these bytes and never reconstruct prompt content.
 */
export async function resolveNativeSessionPrompt(
  options: AgentServiceOptions | undefined,
  catId: string,
  testFactory?: NativeSessionPromptTestFactory,
  outPath?: string,
): Promise<string> {
  const prompt =
    options?.nativeSessionPrompt ??
    (testFactory
      ? await testFactory({ catId, userId: options?.callbackEnv?.CAT_CAFE_USER_ID, ...(outPath ? { outPath } : {}) })
      : undefined);
  if (!prompt?.trim()) throw new Error(`HookPipeline session prompt missing for ${catId}`);
  if (outPath) writeFileSync(outPath, prompt, 'utf8');
  return prompt;
}
