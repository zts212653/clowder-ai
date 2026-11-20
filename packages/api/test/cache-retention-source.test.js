import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { createRequestGenerationRecorder } = await import(
  '../dist/domains/cats/services/agents/invocation/request-generation-recorder.js'
);
const { TranscriptWriter } = await import('../dist/domains/cats/services/session/TranscriptWriter.js');
const { TranscriptReader } = await import('../dist/domains/cats/services/session/TranscriptReader.js');
const { readClaudeRetentionSource } = await import(
  '../dist/domains/cats/services/session/cache/claude-retention-source.js'
);

for (const carrier of ['print_sdk', 'agent_sdk'])
  test(`F338: ${carrier} retention reuses exact successful bytes through the real transcript writer and reader`, async (t) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'f338-source-'));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const record = {
      id: 'session',
      threadId: 'thread',
      userId: 'owner',
      catId: 'sonnet',
      status: 'active',
      seq: 0,
      cliSessionId: 'native-parent',
      lastUsage: {
        cacheObservation: { invocationId: 'source', nativeSessionId: 'native-parent', model: 'claude-sonnet-5-5' },
      },
    };
    const recorder = createRequestGenerationRecorder({
      invocationId: 'source',
      threadId: 'thread',
      userId: 'owner',
      catId: 'sonnet',
      transcriptWriter: new TranscriptWriter({ dataDir }),
      sessionChainStore: { getActive: async () => record },
      snapshot: () => ({
        continuity: { capability: 'unknown', compactionRefs: [] },
        messageSourceRefs: [],
        nativeInstructionSourceRefs: [],
        presentations: [],
      }),
    });
    const prepared = {
      v: 1,
      message: { body: 'one actual request' },
      nativeInstructions: [
        { body: 'EXACT L0\n', injectionDecision: 'native_l0_compiled' },
        { body: 'EXACT APPEND\n', injectionDecision: 'route_append_system_prompt' },
      ],
      runtime: { provider: 'anthropic', carrier, model: 'claude-sonnet-5-5', reasoningEffort: 'medium' },
      tools: { finalSurface: 'declared_only', declaredServerNames: ['cat-cafe-collab'] },
      providerNativeVisibility: 'unknown',
    };
    const commit = await recorder.recordPrepared(prepared, { attempt: 1 });
    const reader = new TranscriptReader({ dataDir });
    await assert.rejects(
      readClaudeRetentionSource(reader, record),
      /source_unavailable/,
      'assembly is not a successful provider request',
    );
    await recorder.recordTerminal(commit, 'accepted');
    const source = await readClaudeRetentionSource(reader, record);
    assert.equal(source.nativeSystemPrompt, 'EXACT L0\n');
    assert.equal(source.appendSystemPrompt, 'EXACT APPEND\n');
    assert.equal(source.runtime.reasoningEffort, 'medium');
    await assert.rejects(
      readClaudeRetentionSource(reader, { ...record, cliSessionId: 'replaced-native' }),
      /source_unavailable/,
    );
  });
