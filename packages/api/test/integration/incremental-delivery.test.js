/**
 * Incremental Delivery Integration Tests
 * 验证每猫每线程只接收“未发送过”的增量消息，不重复、不漏发。
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';
import { migrateRouterOpts } from '../helpers/agent-registry-helpers.js';

const { AgentRouter } = await import('../../dist/domains/cats/services/agents/routing/AgentRouter.js');
const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
const { InvocationRegistry } = await import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function createCapturingService(catId, replyTextPrefix) {
  const capturedPrompts = [];
  let counter = 0;
  const invoke = mock.fn(async function* (prompt) {
    capturedPrompts.push(prompt);
    counter += 1;
    yield { type: 'session_init', catId, sessionId: `${catId}-sess`, timestamp: Date.now() };
    yield { type: 'text', catId, content: `${replyTextPrefix}-${counter}`, timestamp: Date.now() };
    yield { type: 'done', catId, timestamp: Date.now() };
  });
  return { invoke, capturedPrompts };
}

function extractDeliveredIds(prompt) {
  const ids = new Set();
  const re = /\[(\d{16}-\d{6}-[a-f0-9]{8})\]/g;
  let m;
  while ((m = re.exec(prompt)) !== null) {
    ids.add(m[1]);
  }
  return ids;
}

describe('Incremental Delivery', () => {
  let messageStore;
  let registry;

  beforeEach(() => {
    messageStore = new MessageStore();
    registry = new InvocationRegistry();
  });

  test('same cat across rounds: delivered message IDs must not overlap', async () => {
    const opus = createCapturingService('opus', 'opus-reply');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: opus,
        codexService: createCapturingService('codex', 'codex-reply'),
        geminiService: createCapturingService('gemini', 'gemini-reply'),
        registry,
        messageStore,
      }),
    );

    await collect(router.route('u1', '@opus round-1', 'thread-inc-1'));
    await collect(router.route('u1', '@opus round-2', 'thread-inc-1'));

    const p1 = opus.capturedPrompts[0] ?? '';
    const p2 = opus.capturedPrompts[1] ?? '';

    const ids1 = extractDeliveredIds(p1);
    const ids2 = extractDeliveredIds(p2);

    assert.ok(ids1.size > 0, 'round-1 prompt should carry explicit delivered message IDs');
    assert.ok(ids2.size > 0, 'round-2 prompt should carry explicit delivered message IDs');

    const overlap = [...ids1].filter((id) => ids2.has(id));
    assert.equal(overlap.length, 0, `round-2 must not re-deliver IDs from round-1, overlap=${overlap.join(',')}`);
  });

  test('cross-cat: codex should receive unseen user/peer messages exactly once', async () => {
    const opus = createCapturingService('opus', 'opus-reply');
    const codex = createCapturingService('codex', 'codex-reply');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: opus,
        codexService: codex,
        geminiService: createCapturingService('gemini', 'gemini-reply'),
        registry,
        messageStore,
      }),
    );

    await collect(router.route('u2', '@opus alpha', 'thread-inc-2'));
    await collect(router.route('u2', '@codex beta', 'thread-inc-2'));
    await collect(router.route('u2', '@codex gamma', 'thread-inc-2'));

    const codexPrompt1 = codex.capturedPrompts[0] ?? '';
    const codexPrompt2 = codex.capturedPrompts[1] ?? '';

    // First codex invocation should include all persisted unread visible speech + current.
    assert.ok(codexPrompt1.includes('alpha'), 'codex first prompt should include prior user message alpha');
    assert.ok(codexPrompt1.includes('opus-reply-1'), 'codex first prompt should include unread persisted opus speech');
    assert.ok(codexPrompt1.includes('beta'), 'codex first prompt should include current user message beta');

    // Second codex invocation should not replay alpha/beta again
    assert.ok(!codexPrompt2.includes('alpha'), 'codex second prompt must not replay already delivered alpha');
    assert.ok(!codexPrompt2.includes('beta'), 'codex second prompt must not replay already delivered beta');
    assert.ok(codexPrompt2.includes('gamma'), 'codex second prompt should include new user message gamma');
  });

  test('#91 regression: a 5000-char message must NOT be truncated in incremental path', async () => {
    // Message formatting has an internal injection-safety ceiling, not a per-cat prompt-policy field.
    const msgLength = 5000;
    assert.ok(msgLength > 2000, `test requires msgLength > 2000, got ${msgLength}`);
    const longUserMsg = `@opus ${'X'.repeat(msgLength - 30)}_TAIL_MARKER_91`;

    const codex = createCapturingService('codex', 'codex-reply');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createCapturingService('opus', 'opus-reply'),
        codexService: codex,
        geminiService: createCapturingService('gemini', 'gemini-reply'),
        registry,
        messageStore,
      }),
    );

    // Round 1: long user message goes to opus (codex hasn't seen it yet)
    await collect(router.route('u3', longUserMsg, 'thread-inc-91'));
    // Round 2: codex is invoked — should see long user message via incremental context
    await collect(router.route('u3', '@codex review this', 'thread-inc-91'));

    const codexPrompt = codex.capturedPrompts[0] ?? '';
    // The tail marker must survive — old `truncate: 2000` would chop it
    assert.ok(
      codexPrompt.includes('_TAIL_MARKER_91'),
      'codex prompt must preserve tail of long user message (>2000 chars, within budget)',
    );
    // Must NOT contain truncation marker for within-budget messages
    assert.ok(
      !/\[\.\.\.truncated \d+ chars\.\.\.\]/.test(codexPrompt),
      'within-budget message must not be truncated in incremental path',
    );
  });
});
