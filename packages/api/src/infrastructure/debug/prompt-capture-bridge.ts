/**
 * F153 Prompt X-Ray: Thin bridge between invoke-single-cat and PromptCaptureStore.
 * Fire-and-forget — never blocks invocation.
 *
 * AC-G10 (Phase G native L0 closure / KD-44): when the caller flags an F203
 * native-L0 provider, this bridge asynchronously fetches the compiled L0 via
 * `compileL0ViaSubprocess` and stamps `nativeSystemPrompt` onto the capture
 * before persisting. Fetch failures are recorded in `captureDiagnostics` —
 * the invocation hot path is never blocked or made to fail.
 */

import { randomUUID } from 'node:crypto';
import { compileL0ViaSubprocess } from '../../domains/cats/services/agents/providers/l0-compiler.js';
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
  /**
   * AC-G10: When true, the provider injects L0 via a native system-role
   * channel (Claude `--system-prompt-file` / Codex `-c developer_instructions`).
   * The bridge will best-effort fetch the compiled L0 via the existing
   * `compileL0ViaSubprocess` cache and stamp it onto `nativeSystemPrompt`.
   * The caller flags this via `service.injectsL0Natively?.() ?? false`.
   */
  nativeL0Provider?: boolean;
  /**
   * Test seam — replaces the L0 fetcher (default `compileL0ViaSubprocess`).
   * Production callers leave this undefined.
   */
  nativeL0Fetcher?: (catId: string) => Promise<string>;
}

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

  if (input.nativeL0Provider) {
    const fetcher = input.nativeL0Fetcher ?? defaultFetcher;
    try {
      const l0 = await fetcher(input.catId);
      if (l0 && l0.trim().length > 0) {
        nativeSystemPrompt = l0;
        nativeSystemPromptSource = 'f203-l0';
        nativeSystemTokenEstimate = estimateTokens(l0);
      } else {
        diagnostics.push('native-l0-empty: fetcher returned empty string');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      diagnostics.push(`native-l0-fetch-failed: ${msg}`);
      log.warn(
        { err, catId: input.catId },
        'AC-G10 native L0 fetch failed (capture continues without nativeSystemPrompt)',
      );
    }
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

/** Default L0 fetcher — module-level so tests can override via input.nativeL0Fetcher. */
async function defaultFetcher(catId: string): Promise<string> {
  return compileL0ViaSubprocess({ catId });
}

export function getPromptCaptureStore(): PromptCaptureStore {
  return getStore();
}
