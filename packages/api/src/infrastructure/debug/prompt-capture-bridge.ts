/**
 * F153 Prompt X-Ray legacy bridge.
 *
 * F299 Phase D removed every production caller. The export remains only so
 * existing captures and compatibility tests can be read until the legacy ring
 * expires; new invocations use transcript-owned request-generation evidence.
 *
 * Native providers may include the exact route-owned session prompt in the
 * capture. The bridge never reassembles or fetches prompt content itself.
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
  /** Exact session prompt delivered through the provider-native channel. */
  nativeSessionPrompt?: string;
}

/** @deprecated F299 request generations are the sole production writer. */
export function capturePromptIfEnabled(input: CaptureInput): void {
  if (!isPromptCaptureEnabled(input.catId)) return;

  // Spawn the async pipeline without awaiting — fire-and-forget per the
  // F153 KD-28 invariant (capturePromptIfEnabled never blocks invocation
  // hot path). The async fn itself catches every failure mode.
  void runCapture(input);
}

async function runCapture(input: CaptureInput): Promise<void> {
  const diagnostics: string[] = [];
  let nativeSystemPrompt: string | undefined;
  let nativeSystemPromptSource: PromptCapture['nativeSystemPromptSource'];
  let nativeSystemTokenEstimate: number | undefined;

  const routeOwnedSessionPrompt = input.nativeSessionPrompt;
  if (routeOwnedSessionPrompt?.trim()) {
    nativeSystemPrompt = routeOwnedSessionPrompt;
    nativeSystemPromptSource = 'f203-l0';
    nativeSystemTokenEstimate = estimateTokens(routeOwnedSessionPrompt);
  }

  try {
    const captureId = randomUUID();
    const tokenEstimate = estimateTokens(input.effectivePrompt);
    const totalTokenEstimate =
      nativeSystemTokenEstimate !== undefined ? tokenEstimate + nativeSystemTokenEstimate : tokenEstimate;
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
      tokenEstimate,
      // AC-G10 native L0 fields — omitted when no native channel sent.
      ...(nativeSystemPrompt !== undefined ? { nativeSystemPrompt } : {}),
      ...(nativeSystemPromptSource !== undefined ? { nativeSystemPromptSource } : {}),
      ...(nativeSystemTokenEstimate !== undefined ? { nativeSystemTokenEstimate } : {}),
      totalTokenEstimate,
      ...(diagnostics.length > 0 ? { captureDiagnostics: diagnostics } : {}),
    };

    getStore().captureAsync(data);
  } catch (err) {
    log.warn({ err, catId: input.catId }, 'Prompt capture failed (non-fatal)');
  }
}

export function getPromptCaptureStore(): PromptCaptureStore {
  return getStore();
}
