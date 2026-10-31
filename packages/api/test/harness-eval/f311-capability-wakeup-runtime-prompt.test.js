import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CapabilityWakeupTrialProviderImpl } from '../../dist/infrastructure/harness-eval/capability-wakeup/capability-wakeup-trial-provider-impl.js';

const sessionId = 'session-f311-runtime';
const threadId = 'thread-f311-runtime';
const catId = 'codex-sol';
const invocationId = 'invocation-f311-runtime';

function transcriptEvent(eventNo, event) {
  return {
    v: 1,
    t: 1_788_421_000_000 + eventNo,
    threadId,
    catId,
    sessionId,
    cliSessionId: 'cli-f311-runtime',
    invocationId,
    eventNo,
    event,
  };
}

function providerFor(prompt, assistantText = 'The assistant response does not repeat the user request.', promptRead) {
  return new CapabilityWakeupTrialProviderImpl({
    sessionStore: {
      get: () => ({ threadId, catId, userId: 'default-user' }),
    },
    transcriptReader: {
      readEvents: async () => ({
        events: [
          transcriptEvent(0, {
            type: 'text',
            content: assistantText,
          }),
        ],
        total: 1,
      }),
    },
    promptReader: {
      read: async () =>
        promptRead ?? {
          status: 'available',
          sourceMessageId: 'message-f311-runtime-prompt',
          content: prompt,
        },
    },
    toolEventLog: {
      readByThread: async () => [
        {
          invocationId,
          sessionId,
          threadId,
          catId,
          toolName: 'cat_cafe_start_evolution_program',
          timestamp: 1_788_421_000_001,
          turnIndex: 0,
          status: 'success',
          summary: { ok: true },
        },
      ],
    },
    skillLoadEventLog: { readBySession: async () => [] },
  });
}

const selector = {
  kind: 'capability-wakeup-trial-window',
  capability: 'capability-evolution',
  ruleIds: ['capability-evolution-concrete-target'],
  windowStartMs: 0,
  windowEndMs: 9_999_999_999_999,
  sessionIds: [sessionId],
};

describe('F311 runtime prompt population', () => {
  it('measures the concrete user request even when the assistant does not echo it', async () => {
    const trials = await providerFor('我们来进化视频生成能力').resolve(selector);
    assert.equal(trials.length, 1);
    assert.equal(trials[0].capability, 'capability-evolution');
    assert.equal(trials[0].outcome, 'negative');
    assert.match(trials[0].usageEvidence[0], /cat_cafe_start_evolution_program/u);
  });

  it('does not turn an informational user question into a creation opportunity', async () => {
    const trials = await providerFor('我们来进化 嗯？ 你们能自进化什么东西？').resolve(selector);
    assert.deepEqual(trials, []);
  });

  it('falls back to historical transcript text only when prompt provenance is genuinely unavailable', async () => {
    const provider = providerFor('ignored', '我们来进化视频生成能力', {
      status: 'historical_unavailable',
      reason: 'prompt_message_ids_unavailable',
    });
    const trials = await provider.resolve(selector);
    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'negative');
  });

  it('does not fall back to assistant echoes for rejected current prompt projections', async () => {
    const provider = providerFor('ignored', '我们来进化视频生成能力', {
      status: 'rejected',
      reason: 'deleted',
    });
    assert.deepEqual(await provider.resolve(selector), []);
  });
});
