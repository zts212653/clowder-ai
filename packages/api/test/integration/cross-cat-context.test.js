/**
 * Cross-Cat Context Integration Tests (Phase 3.6)
 * 暗号测试 — 验证 ContextAssembler 让猫能看到其他猫的历史
 *
 * 使用 mock agent services + 真实 MessageStore，验证:
 * - 猫 A 的回复出现在猫 B 的 prompt 中
 * - 三猫场景下所有暗号可见
 * - 历史截断到 maxMessages
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';
import { migrateRouterOpts } from '../helpers/agent-registry-helpers.js';

const { AgentRouter } = await import('../../dist/domains/cats/services/agents/routing/AgentRouter.js');
const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');
const { InvocationRegistry } = await import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');

/** Collect all items from async iterable */
async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

/** Create a mock service that captures the prompt it receives and replies with given text */
function createCapturingService(catId, replyText) {
  const capturedPrompts = [];
  const invoke = mock.fn(async function* (prompt) {
    capturedPrompts.push(prompt);
    yield { type: 'session_init', catId, sessionId: `${catId}-sess`, timestamp: Date.now() };
    yield { type: 'text', catId, content: replyText, timestamp: Date.now() };
    yield { type: 'done', catId, timestamp: Date.now() };
  });
  return { invoke, capturedPrompts };
}

describe('Cross-Cat Context (暗号测试)', () => {
  let messageStore;
  let threadStore;
  let registry;

  beforeEach(() => {
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    registry = new InvocationRegistry();
  });

  test('secret token: cat B sees cat A reply in its prompt', async () => {
    const SECRET = 'SECRET_TOKEN_ALPHA_12345';
    const opusService = createCapturingService('opus', `I confirm: ${SECRET}`);
    const codexService = createCapturingService('codex', 'Received');

    // Use debug thinkingMode so stream-origin cat messages are visible in incremental context
    const thread = threadStore.create('user-1', 'secret token test');
    threadStore.updateThinkingMode(thread.id, 'debug');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: opusService,
        codexService: codexService,
        geminiService: createCapturingService('gemini', 'skip'),
        registry,
        messageStore,
        threadStore,
      }),
    );

    // Round 1: user → opus → opus replies with SECRET
    await collect(router.route('user-1', '@opus tell me the secret', thread.id));

    // Round 2: user → codex — codex should see opus's reply in context history
    await collect(router.route('user-1', '@codex what was the secret?', thread.id));

    const codexPrompt = codexService.capturedPrompts[0];
    assert.ok(
      codexPrompt.includes(SECRET),
      `Codex prompt should contain the secret token. Got: ${codexPrompt.slice(0, 500)}`,
    );
    assert.ok(codexPrompt.includes('对话历史'), 'Codex prompt should contain history header');
  });

  test('three-cat secret: cat C sees both cat A and cat B secrets', async () => {
    const SECRET_A = 'OPUS_SECRET_777';
    const SECRET_B = 'CODEX_SECRET_888';
    const opusService = createCapturingService('opus', `My secret is ${SECRET_A}`);
    const codexService = createCapturingService('codex', `My secret is ${SECRET_B}`);
    const geminiService = createCapturingService('gemini', 'I see them');

    const thread = threadStore.create('user-1', 'three-cat secret test');
    threadStore.updateThinkingMode(thread.id, 'debug');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: opusService,
        codexService: codexService,
        geminiService: geminiService,
        registry,
        messageStore,
        threadStore,
      }),
    );

    await collect(router.route('user-1', '@opus share your secret', thread.id));
    await collect(router.route('user-1', '@codex share your secret', thread.id));
    await collect(router.route('user-1', '@gemini what secrets did they share?', thread.id));

    const geminiPrompt = geminiService.capturedPrompts[0];
    assert.ok(geminiPrompt.includes(SECRET_A), 'Gemini should see opus secret in history');
    assert.ok(geminiPrompt.includes(SECRET_B), 'Gemini should see codex secret in history');
  });

  test('history delivery: includes unseen history without replay markers', async () => {
    const opusService = createCapturingService('opus', 'final reply');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: opusService,
        codexService: createCapturingService('codex', 'x'),
        geminiService: createCapturingService('gemini', 'x'),
        registry,
        messageStore,
      }),
    );

    // Seed 25 messages directly into messageStore
    for (let i = 0; i < 25; i++) {
      await messageStore.append({
        userId: 'user-1',
        catId: i % 2 === 0 ? null : 'opus',
        content: `history-msg-${i}`,
        mentions: [],
        timestamp: i * 1000,
        threadId: 'thread-3',
      });
    }

    await collect(router.route('user-1', '@opus summarize', 'thread-3'));

    const prompt = opusService.capturedPrompts[0];
    // Incremental mode should include unseen history and avoid old replay envelope marker.
    assert.ok(prompt.includes('history-msg-24'), 'Should include most recent message');
    assert.ok(prompt.includes('history-msg-0'), 'Should include oldest unseen message as well');
    assert.ok(prompt.includes('对话历史增量'), 'Should use incremental history header');
    assert.ok(!prompt.includes('[对话历史 - 最近'), 'Should not carry legacy replay header');
  });

  test('multi-round visibility: new cat sees full conversation', async () => {
    const opusService = createCapturingService('opus', 'Round 1 opus answer');
    const codexService = createCapturingService('codex', 'Round 2 codex answer');
    const geminiService = createCapturingService('gemini', 'I see everything');

    const thread = threadStore.create('user-1', 'multi-round test');
    threadStore.updateThinkingMode(thread.id, 'debug');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: opusService,
        codexService: codexService,
        geminiService: geminiService,
        registry,
        messageStore,
        threadStore,
      }),
    );

    // Round 1
    await collect(router.route('user-1', '@opus first question', thread.id));
    // Round 2
    await collect(router.route('user-1', '@codex second question', thread.id));
    // Round 3: new cat joins
    await collect(router.route('user-1', '@gemini what happened?', thread.id));

    const geminiPrompt = geminiService.capturedPrompts[0];
    assert.ok(geminiPrompt.includes('first question'), 'Gemini sees round 1 user message');
    assert.ok(geminiPrompt.includes('Round 1 opus answer'), 'Gemini sees opus reply');
    assert.ok(geminiPrompt.includes('second question'), 'Gemini sees round 2 user message');
    assert.ok(geminiPrompt.includes('Round 2 codex answer'), 'Gemini sees codex reply');
  });
});
