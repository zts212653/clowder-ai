import {
  CodexActiveWriterRecoveryError,
  captureCodexActiveWriterDetection,
} from '../../runtime-session/CodexSessionReplacementProvenance.js';
import { asCodexAppServerRecord } from './CodexAppServerEventMapper.js';
import { isCodexAppServerRpcError } from './codex-app-server-rpc-error.js';

/**
 * F296 B4a: the continuity fact this adapter observed at the provider boundary.
 *
 * Every variant is derived from an actual `thread/start` / `thread/resume`
 * response. `resumed` is minted here and nowhere else, and only when the
 * provider echoed back exactly the id we asked for.
 */
export type CodexAppServerThreadVerdict =
  | { readonly kind: 'started'; readonly threadId: string; readonly raw: unknown }
  | {
      readonly kind: 'resumed';
      readonly requestedThreadId: string;
      readonly threadId: string;
      readonly raw: unknown;
    }
  | {
      readonly kind: 'replaced';
      readonly requestedThreadId: string;
      readonly threadId: string;
      readonly raw: unknown;
    }
  | {
      readonly kind: 'mismatched';
      readonly requestedThreadId: string;
      readonly threadId: string;
      readonly raw: unknown;
    };

/**
 * Does this provider rejection positively mean "the requested thread does not
 * exist"?
 *
 * Matching on text is not a shortcut taken for convenience — the probe above
 * established there is no structural discriminator on this provider. Keep this
 * narrow: every phrase here must be one an actual app-server was observed to
 * emit. Widening it trades a loud failure for a silent session replacement.
 *
 * `Invalid request:` is serde-level request rejection, i.e. always OUR bug, and
 * is refused explicitly so no future phrase can accidentally capture it.
 */
export function isThreadNotResumableRejection(message: string): boolean {
  const text = message.trim();
  if (/^Invalid request:/i.test(text)) return false;
  return /^no rollout found for thread id \S+$/i.test(text);
}

function threadIdOf(response: unknown): string {
  const record = asCodexAppServerRecord(response);
  const thread = asCodexAppServerRecord(record?.thread);
  const threadId = thread?.id;
  if (typeof threadId !== 'string' || threadId.length === 0) {
    throw new Error('Codex app-server did not return a thread id');
  }
  return threadId;
}

export async function resolveCodexAppServerThread(input: {
  thread: { kind: 'start' } | { kind: 'resume'; threadId: string };
  params: Record<string, unknown>;
  /** Params for the fallback `thread/start` after a provider-rejected resume. */
  startParams?: Record<string, unknown>;
  localLiveLease: boolean;
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  now: () => number;
}): Promise<CodexAppServerThreadVerdict> {
  if (input.thread.kind === 'start') {
    const raw = await input.request('thread/start', input.params);
    return { kind: 'started', threadId: threadIdOf(raw), raw };
  }

  const requestedThreadId = input.thread.threadId;
  let raw: unknown;
  try {
    raw = await input.request('thread/resume', input.params);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (/^thread \S+ already has an active writer$/.test(failure.message.trim())) {
      const detectedAt = input.now();
      const detection = await captureCodexActiveWriterDetection({
        threadId: requestedThreadId,
        observedAt: detectedAt,
        localLiveLease: input.localLiveLease,
        readThread: () => input.request('thread/read', { threadId: requestedThreadId, includeTurns: true }),
      });
      throw new CodexActiveWriterRecoveryError(failure.message, detection);
    }
    // Only a provider *verdict* may be answered with a fallback start, and only
    // a verdict that positively means "this thread does not exist".
    //
    // A broken pipe is not a verdict, so a non-RPC error always propagates.
    // But being a JSON-RPC error is not sufficient either: a follow-up probe on
    // codex-cli 0.147.0 (2026-08-20) showed the app-server answers BOTH cases
    // with the same code, so `-32600` cannot discriminate:
    //
    //   stale resume  -> -32600 "no rollout found for thread id <uuid>"
    //   our own bug   -> -32600 "Invalid request: missing field `threadId`"
    //
    // So this defaults to propagating and only falls back on a positively
    // recognised not-found. The asymmetry is deliberate: an unrecognised
    // rejection fails the invocation loudly, whereas the opposite default would
    // silently discard session continuity and bury the real bug behind a
    // brand-new runtime.
    if (!isCodexAppServerRpcError(failure) || !isThreadNotResumableRejection(failure.message)) throw failure;
    const fallback = await input.request('thread/start', input.startParams ?? {});
    return {
      kind: 'replaced',
      requestedThreadId,
      threadId: threadIdOf(fallback),
      raw: fallback,
    };
  }

  const threadId = threadIdOf(raw);
  // A response for a different id is never coerced to resumed.
  if (threadId !== requestedThreadId) {
    return { kind: 'mismatched', requestedThreadId, threadId, raw };
  }
  return { kind: 'resumed', requestedThreadId, threadId, raw };
}
