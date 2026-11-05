import { readOpenCodeLocalSessions, resolveOpenCodeLocalIndex } from './OpenCodeLocalSessionIndex.js';
import { inspectOpenCodeLocalSession } from './OpenCodeLocalSessionInspection.js';
import type { OpenCodeLocalReadResult, OpenCodeLocalSelection } from './OpenCodeLocalSessionReader.js';

export async function readOpenCodeLocalSessionOperation(
  input: OpenCodeLocalSelection,
): Promise<OpenCodeLocalReadResult> {
  try {
    const path = input.path ?? resolveOpenCodeLocalIndex();
    const listing =
      'sessionId' in input
        ? { sessions: [await inspectOpenCodeLocalSession(path, input.sessionId)], limited: false }
        : readOpenCodeLocalSessions(path, { limit: input.limit });
    return { ok: true, listing };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    return {
      ok: false,
      code: code === 'SESSION_ACTIVE_WRITER' || code === 'SESSION_NOT_TOP_LEVEL' ? code : 'SESSION_RESUME_FAILED',
    };
  }
}
