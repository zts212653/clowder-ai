import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import './helpers/setup-cat-registry.js';

const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');

describe('F046 B5 runtime regression scenarios after lifecycle cutover', () => {
  it('keeps line-start routing independent of keyword and paragraph shape', () => {
    assert.deepEqual(parseA2AMentions('@缅因猫 收到，我在等', 'opus'), ['codex']);
    assert.deepEqual(parseA2AMentions('@缅因猫 请确认这个变更', 'opus'), ['codex']);
    assert.deepEqual(parseA2AMentions('@缅因猫\n\n这是交接文档', 'opus'), ['codex']);
    assert.deepEqual(parseA2AMentions('@缅因猫 prefix issue', 'opus'), ['codex']);
  });

  // Completed-response wake behavior is exercised through the real route in
  // route-strategies.test.js and f247-serial-cloud-source.test.js.

  it('keeps dynamic identity metadata handle-free', () => {
    const context = buildInvocationContext({
      catId: 'codex',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      teammates: ['opus'],
      mcpAvailable: false,
      directMessageFrom: 'opus',
      activeParticipants: [{ catId: 'opus', lastMessageAt: 1_710_000_000_000, messageCount: 3 }],
    });

    assert.match(context, /^Direct message from 布偶猫\(opus\)/m);
    assert.match(context, /最近发言：布偶猫\(opus\)/);
    assert.doesNotMatch(context, /Direct message from @opus|最近发言：@opus/);
  });
});
