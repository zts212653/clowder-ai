import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
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

  it('commits downstream A2A only from a completed response instead of recursive route execution', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '../src/domains/cats/services/agents/routing/route-serial.ts'), 'utf8');

    assert.match(source, /lifecycleResponse\?\.status === 'completed' && a2aMentions\.length > 0/);
    assert.match(source, /commitCompletedA2AWake\(/);
    assert.doesNotMatch(source, /Routing feedback\(one-shot\):/);
  });

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
    assert.match(context, /最近活跃：布偶猫\(opus\)/);
    assert.doesNotMatch(context, /Direct message from @opus|最近活跃：@opus/);
  });
});
