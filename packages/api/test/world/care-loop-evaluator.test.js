import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CareLoopEvaluator } from '../../dist/domains/world/CareLoopEvaluator.js';

function makeEvent(type, payload, index) {
  return {
    eventId: `evt-${index}`,
    worldId: 'w1',
    sceneId: 's1',
    type,
    actor: { kind: 'cat', id: 'opus' },
    payload,
    createdAt: '2026-04-30T12:00:00Z',
  };
}

describe('CareLoopEvaluator', () => {
  it('returns undefined when too few events since last care check', () => {
    const evaluator = new CareLoopEvaluator({ minEventsBetweenChecks: 5 });
    const events = [
      makeEvent('care_check_in', { suggestion: 'ok' }, 0),
      makeEvent('dialogue', { content: 'I feel lonely' }, 1),
      makeEvent('dialogue', { content: 'me too' }, 2),
    ];
    const hint = evaluator.evaluate(events, []);
    assert.equal(hint, undefined, 'should not trigger with <5 events since last care');
  });

  it('triggers when enough events pass with trigger keyword', () => {
    const evaluator = new CareLoopEvaluator({ minEventsBetweenChecks: 3 });
    const events = Array.from({ length: 4 }, (_, i) =>
      makeEvent('dialogue', { content: i === 2 ? 'I feel so lonely' : 'normal chat' }, i),
    );
    const characters = [
      {
        characterId: 'ch1',
        worldId: 'w1',
        coreIdentity: { name: 'A.W.' },
        updatedAt: '2026-04-30T12:00:00Z',
      },
    ];
    events[2].characterId = 'ch1';
    const hint = evaluator.evaluate(events, characters);
    assert.ok(hint, 'should trigger');
    assert.ok(hint.trigger.includes('lonely'));
    assert.ok(hint.suggestion.length > 0);
    assert.ok(hint.realityBridge.includes('A.W.'));
  });

  it('respects Chinese trigger keywords', () => {
    const evaluator = new CareLoopEvaluator({ minEventsBetweenChecks: 2 });
    const events = [
      makeEvent('dialogue', { content: '今天好累啊' }, 0),
      makeEvent('narration', { content: '一切归于平静' }, 1),
      makeEvent('dialogue', { content: '继续冒险' }, 2),
    ];
    const hint = evaluator.evaluate(events, []);
    assert.ok(hint, 'should detect Chinese keyword 累');
    assert.ok(hint.trigger.includes('累'));
  });

  it('returns undefined when no trigger keywords found', () => {
    const evaluator = new CareLoopEvaluator({ minEventsBetweenChecks: 2 });
    const events = [
      makeEvent('dialogue', { content: 'hello world' }, 0),
      makeEvent('dialogue', { content: 'how are you' }, 1),
      makeEvent('narration', { content: 'the sun was shining' }, 2),
    ];
    const hint = evaluator.evaluate(events, []);
    assert.equal(hint, undefined, 'no trigger keyword → no hint');
  });

  it('resets counter after care_check_in event', () => {
    const evaluator = new CareLoopEvaluator({ minEventsBetweenChecks: 3 });
    const events = [
      makeEvent('dialogue', { content: 'I am sad' }, 0),
      makeEvent('dialogue', { content: 'very sad' }, 1),
      makeEvent('dialogue', { content: 'so sad' }, 2),
      makeEvent('dialogue', { content: 'deeply sad' }, 3),
      makeEvent('care_check_in', { suggestion: 'checked in' }, 4),
      makeEvent('dialogue', { content: 'still sad' }, 5),
    ];
    const hint = evaluator.evaluate(events, []);
    assert.equal(hint, undefined, 'only 1 event since last care_check_in');
  });
});
