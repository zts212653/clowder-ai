/**
 * F153 Prompt X-Ray: Thin bridge between invoke-single-cat and PromptCaptureStore.
 * Fire-and-forget — never blocks invocation.
 */

import { randomUUID } from 'node:crypto';
import { createModuleLogger } from '../logger.js';
import { pseudonymizeId } from '../telemetry/hmac.js';
import {
  estimateTokens,
  isPromptCaptureEnabled,
  type PromptCapture,
  PromptCaptureStore,
} from './prompt-capture-store.js';

const log = createModuleLogger('debug:prompt-capture-bridge');

let _store: PromptCaptureStore | undefined;

function getStore(): PromptCaptureStore {
  if (!_store) _store = new PromptCaptureStore();
  return _store;
}

export interface CaptureInput {
  catId: string;
  invocationId: string;
  threadId: string;
  userId: string;
  model: string;
  systemPrompt: string;
  missionPrefix?: string;
  userPrompt: string;
  effectivePrompt: string;
  injectionDecision: {
    isResume: boolean;
    canSkipOnResume: boolean;
    forceReinjection: boolean;
    injected: boolean;
  };
}

export function capturePromptIfEnabled(input: CaptureInput): void {
  if (!isPromptCaptureEnabled(input.catId)) return;

  try {
    const captureId = randomUUID();
    const data: PromptCapture = {
      captureId,
      invocationId: input.invocationId,
      hmacInvocationId: pseudonymizeId(input.invocationId),
      catId: input.catId,
      threadId: input.threadId,
      userId: input.userId,
      model: input.model,
      capturedAt: Date.now(),
      systemPrompt: input.systemPrompt,
      missionPrefix: input.missionPrefix,
      userPrompt: input.userPrompt,
      effectivePrompt: input.effectivePrompt,
      injectionDecision: input.injectionDecision,
      promptBytes: Buffer.byteLength(input.effectivePrompt, 'utf8'),
      tokenEstimate: estimateTokens(input.effectivePrompt),
    };

    getStore().captureAsync(data);
  } catch (err) {
    log.warn({ err, catId: input.catId }, 'Prompt capture failed (non-fatal)');
  }
}

export function getPromptCaptureStore(): PromptCaptureStore {
  return getStore();
}
