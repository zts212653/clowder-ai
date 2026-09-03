import {
  CodexActiveWriterRecoveryError,
  type CodexNativeResumeRejection,
  type CodexNativeResumeReplacementProvenance,
  type CodexSessionReplacementProvenance,
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
      readonly replacement: CodexSessionReplacementProvenance;
      readonly raw: unknown;
    }
  | {
      readonly kind: 'mismatched';
      readonly requestedThreadId: string;
      readonly threadId: string;
      readonly raw: unknown;
    };

/**
 * The provider rejected a resume by terminating the carrier before it could
 * form a JSON-RPC envelope. A fallback `thread/start` cannot use that dead
 * carrier, so the bounded runner must acquire a fresh one first.
 */
export class CodexAppServerCarrierReplacementRequiredError extends Error {
  readonly replacement: CodexNativeResumeReplacementProvenance;

  constructor(message: string, replacement: CodexNativeResumeReplacementProvenance) {
    super(message);
    this.name = 'CodexAppServerCarrierReplacementRequiredError';
    this.replacement = replacement;
  }
}

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

function classifyNativeResumeRejection(message: string): CodexNativeResumeRejection | undefined {
  const text = message.trim();
  if (isThreadNotResumableRejection(text)) return 'rollout_not_found';
  if (text === 'Max payload size exceeded') return 'max_payload_size_exceeded';
  return undefined;
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
  /** Provenance retained while a dead resume carrier is replaced. */
  resumeReplacement?: CodexNativeResumeReplacementProvenance;
  localLiveLease: boolean;
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  now: () => number;
}): Promise<CodexAppServerThreadVerdict> {
  if (input.thread.kind === 'start') {
    const raw = await input.request('thread/start', input.params);
    const threadId = threadIdOf(raw);
    if (input.resumeReplacement) {
      return {
        kind: 'replaced',
        requestedThreadId: input.resumeReplacement.previousNativeThreadId,
        threadId,
        replacement: input.resumeReplacement,
        raw,
      };
    }
    return { kind: 'started', threadId, raw };
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
    // Only a provider *verdict* may be answered with a fallback start on the
    // same carrier. Being a JSON-RPC error is not sufficient: a follow-up probe on
    // codex-cli 0.147.0 (2026-08-20) showed the app-server answers BOTH cases
    // with the same code, so `-32600` cannot discriminate:
    //
    //   stale resume  -> -32600 "no rollout found for thread id <uuid>"
    //   our own bug   -> -32600 "Invalid request: missing field `threadId`"
    //
    // So an unrecognised rejection still propagates loudly. There is one exact
    // non-RPC exception: production evidence shows an oversized native rollout
    // kills the carrier during thread/resume with this text and no envelope.
    // That case requests a fresh-carrier start from the bounded runner; it never
    // attempts another RPC on the dead carrier.
    const rejection = classifyNativeResumeRejection(failure.message);
    if (!rejection) throw failure;
    // Not-found is a JSON-RPC provider verdict. The observed max-payload
    // terminal instead closes the carrier request without an RPC envelope, but
    // it is equally bounded: exact text, during thread/resume, before turn/start.
    const detectedAt = input.now();
    const replacement: CodexNativeResumeReplacementProvenance = {
      cause: 'native_resume_rejected',
      previousNativeThreadId: requestedThreadId,
      detectedAt,
      rejection,
    };
    if (!isCodexAppServerRpcError(failure)) {
      if (rejection === 'rollout_not_found') throw failure;
      throw new CodexAppServerCarrierReplacementRequiredError(failure.message, replacement);
    }
    const fallback = await input.request('thread/start', input.startParams ?? {});
    return {
      kind: 'replaced',
      requestedThreadId,
      threadId: threadIdOf(fallback),
      replacement,
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
