import {
  CodexActiveWriterRecoveryError,
  captureCodexActiveWriterDetection,
} from '../../runtime-session/CodexSessionReplacementProvenance.js';

export async function resolveCodexAppServerThread(input: {
  thread: { kind: 'start' } | { kind: 'resume'; threadId: string };
  params: Record<string, unknown>;
  localLiveLease: boolean;
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  now: () => number;
}): Promise<unknown> {
  if (input.thread.kind === 'start') return input.request('thread/start', input.params);

  const threadId = input.thread.threadId;
  try {
    return await input.request('thread/resume', input.params);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!/^thread \S+ already has an active writer$/.test(failure.message.trim())) throw failure;
    const detectedAt = input.now();
    const detection = await captureCodexActiveWriterDetection({
      threadId,
      observedAt: detectedAt,
      localLiveLease: input.localLiveLease,
      readThread: () => input.request('thread/read', { threadId, includeTurns: true }),
    });
    throw new CodexActiveWriterRecoveryError(failure.message, detection);
  }
}
