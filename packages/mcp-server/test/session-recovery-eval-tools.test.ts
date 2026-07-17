import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { z } from 'zod';
import {
  handlePreviewSessionRecoveryTrials,
  handleReadSessionRecoveryEvidence,
  previewSessionRecoveryTrialsInputSchema,
  readSessionRecoveryEvidenceInputSchema,
  sessionRecoveryEvalTools,
} from '../src/tools/session-recovery-eval-tools.js';

describe('cat_cafe_preview_session_recovery_trials', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CAT_CAFE_API_URL = 'http://localhost:3004';
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-session-recovery-preview';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'token-session-recovery-preview';
    delete process.env.CAT_CAFE_CREDENTIAL_FILE;
  });

  afterEach(() => {
    mock.restoreAll();
    process.env = { ...originalEnv };
  });

  it('registers bounded preview and trial-anchored evidence tools while keeping assessments out of MCP', () => {
    assert.deepEqual(
      sessionRecoveryEvalTools.map((tool) => tool.name),
      ['cat_cafe_preview_session_recovery_trials', 'cat_cafe_read_session_recovery_evidence'],
    );
    const schema = z.object(previewSessionRecoveryTrialsInputSchema);
    const parsed = schema.safeParse({
      windowStartMs: 1_000,
      windowEndMs: 2_000,
      catId: 'cat-vjdun65e',
      threadId: 'thread-1',
      limit: 50,
    });
    assert.equal(parsed.success, true);
    assert.equal('assessments' in previewSessionRecoveryTrialsInputSchema, false);
    assert.equal(schema.safeParse({ windowStartMs: 1_000, windowEndMs: 2_000, limit: 201 }).success, false);
    assert.equal(
      schema.safeParse({ windowStartMs: 1_000, windowEndMs: 2_000, threadId: 'thread-1\nforged' }).success,
      false,
    );

    const evidenceSchema = z.object(readSessionRecoveryEvidenceInputSchema);
    assert.equal(
      evidenceSchema.safeParse({
        windowStartMs: 1_000,
        windowEndMs: 2_000,
        trialId: 'session-recovery:target-1',
        evidenceKind: 'target_opening_invocation',
      }).success,
      true,
    );
    assert.equal('sessionId' in readSessionRecoveryEvidenceInputSchema, false);
    assert.equal('invocationId' in readSessionRecoveryEvidenceInputSchema, false);
  });

  it('posts a fixed-kind selector with callback auth headers and no owner self-report', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async (url, init) => {
      const headers = init?.headers as Record<string, string>;
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ url, headers, body }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const result = await handlePreviewSessionRecoveryTrials({
      windowStartMs: 1_000,
      windowEndMs: 2_000,
      catId: 'cat-vjdun65e',
      limit: 10,
    });

    assert.equal(fetchMock.mock.calls.length, 1);
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    const payload = JSON.parse(text);
    assert.equal(payload.url, 'http://localhost:3004/api/eval-domains/eval%3Asession-recovery/preview-trials');
    assert.equal(payload.headers['x-invocation-id'], 'inv-session-recovery-preview');
    assert.equal(payload.headers['x-callback-token'], 'token-session-recovery-preview');
    assert.deepEqual(payload.body, {
      selector: {
        kind: 'session-recovery-window',
        windowStartMs: 1_000,
        windowEndMs: 2_000,
        catId: 'cat-vjdun65e',
        limit: 10,
      },
    });
    assert.equal('ownerUserId' in payload.body, false);
  });

  it('reads only a trial-anchored evidence kind through callback auth', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async (url, init) => {
      const headers = init?.headers as Record<string, string>;
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ url, headers, body }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const result = await handleReadSessionRecoveryEvidence({
      windowStartMs: 1_000,
      windowEndMs: 2_000,
      catId: 'cat-ga18c3y8',
      trialId: 'session-recovery:target-1',
      evidenceKind: 'target_opening_invocation',
    });

    assert.equal(fetchMock.mock.calls.length, 1);
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    const payload = JSON.parse(text);
    assert.equal(payload.url, 'http://localhost:3004/api/eval-domains/eval%3Asession-recovery/read-evidence');
    assert.deepEqual(payload.body, {
      selector: {
        kind: 'session-recovery-window',
        windowStartMs: 1_000,
        windowEndMs: 2_000,
        catId: 'cat-ga18c3y8',
      },
      trialId: 'session-recovery:target-1',
      evidenceKind: 'target_opening_invocation',
    });
    assert.equal('sessionId' in payload.body, false);
    assert.equal('invocationId' in payload.body, false);
  });
});
