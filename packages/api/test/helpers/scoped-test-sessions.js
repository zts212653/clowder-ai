import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SessionSealer } from '../../dist/domains/cats/services/session/SessionSealer.js';
import { TranscriptWriter } from '../../dist/domains/cats/services/session/TranscriptWriter.js';
import { InMemoryTurnExecutionStore } from '../../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { SessionChainStore } from '../../dist/domains/cats/services/stores/ports/SessionChainStore.js';

/** Real logical session and transcript owners; provider session_init remains explicitly scripted. */
export function scopedTestSessions(dataDirectory) {
  const sessionChainStore = new SessionChainStore();
  const transcriptWriter = new TranscriptWriter({ dataDir: join(dataDirectory, 'scoped-sessions') });
  return {
    sessionChainStore,
    transcriptWriter,
    sessionSealer: new SessionSealer(sessionChainStore, transcriptWriter),
    turnExecutionStore: new InMemoryTurnExecutionStore(),
  };
}

/** Explicit provider stand-in exercising the real immutable request boundary callback. */
export async function* scriptedSessionInit(catId, prompt, options) {
  await options?.beforeProviderLaunch?.({
    v: 1,
    message: { body: prompt },
    nativeInstructions: options.systemPrompt ? [{ body: options.systemPrompt }] : [],
    runtime: { provider: 'fixture', carrier: 'scripted-test-adapter', model: 'fixture-model' },
    providerNativeVisibility: 'unsupported',
    tools: { finalSurface: 'unknown' },
  });
  yield { type: 'session_init', catId, sessionId: randomUUID(), timestamp: Date.now() };
}
