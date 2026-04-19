import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ActivityEventBus } from '../dist/domains/activity/ActivityEventBus.js';
import { LeadershipProjector } from '../dist/domains/activity/LeadershipProjector.js';

describe('LeadershipProjector', () => {
  /** @type {ActivityEventBus} */
  let bus;
  /** @type {{ calls: Array<{source: string, multiplier?: number}>, awardXp: Function }} */
  let mockService;
  /** @type {LeadershipProjector} */
  let projector;

  beforeEach(() => {
    bus = new ActivityEventBus();
    mockService = {
      calls: [],
      awardXp(source, multiplier) {
        mockService.calls.push({ source, multiplier });
      },
    };
    projector = new LeadershipProjector(bus, mockService);
  });

  /** Helper: emit an event and return captured service calls. */
  function emit(type, metadata = {}) {
    bus.record(type, 'co-creator', metadata);
    return mockService.calls;
  }

  describe('coordination (协调力)', () => {
    it('awards multi_mention_dispatch on dispatched event', () => {
      const calls = emit('multi_mention_dispatched', { targets: ['a', 'b'] });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].source, 'multi_mention_dispatch');
    });

    it('awards multi_mention_success on request-level completion', () => {
      const calls = emit('multi_mention_request_completed', {
        targetCount: 2,
        successCount: 2,
        isDeepCollab: false,
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].source, 'multi_mention_success');
    });

    it('skips when successCount is 0', () => {
      const calls = emit('multi_mention_request_completed', {
        targetCount: 2,
        successCount: 0,
        isDeepCollab: false,
      });
      assert.equal(calls.length, 0);
    });

    it('awards target_diversity when targetCount >= 3', () => {
      const calls = emit('multi_mention_request_completed', {
        targetCount: 3,
        successCount: 3,
        isDeepCollab: false,
      });
      const sources = calls.map((c) => c.source);
      assert.ok(sources.includes('multi_mention_success'));
      assert.ok(sources.includes('target_diversity'));
    });

    it('does NOT award target_diversity when targetCount < 3', () => {
      const calls = emit('multi_mention_request_completed', {
        targetCount: 2,
        successCount: 2,
        isDeepCollab: false,
      });
      const sources = calls.map((c) => c.source);
      assert.ok(!sources.includes('target_diversity'));
    });
  });

  describe('delegation (授权力)', () => {
    it('awards deep_collab_initiated for deep collab requests', () => {
      const calls = emit('multi_mention_request_completed', {
        targetCount: 3,
        successCount: 3,
        isDeepCollab: true,
      });
      const sources = calls.map((c) => c.source);
      assert.ok(sources.includes('deep_collab_initiated'));
    });

    it('awards task_no_intervention when interventionCount is 0', () => {
      const calls = emit('task_completed', { interventionCount: 0 });
      const sources = calls.map((c) => c.source);
      assert.ok(sources.includes('task_no_intervention'));
    });

    it('does NOT award task_no_intervention without metadata', () => {
      const calls = emit('task_completed', {});
      const sources = calls.map((c) => c.source);
      assert.ok(!sources.includes('task_no_intervention'));
    });
  });

  describe('guidance (引导力)', () => {
    it('always awards baseline guidance on task_completed', () => {
      const calls = emit('task_completed', {});
      assert.ok(calls.some((c) => c.source === 'one_shot_completion' && c.multiplier === 0.2));
    });

    it('awards bonus one_shot_completion when clarificationCount is 0', () => {
      const calls = emit('task_completed', { clarificationCount: 0 });
      const oneShots = calls.filter((c) => c.source === 'one_shot_completion');
      assert.equal(oneShots.length, 2); // baseline 0.2 + bonus 0.8
      assert.ok(oneShots.some((c) => c.multiplier === 0.8));
    });

    it('awards low_clarification on session_sealed with low count', () => {
      const calls = emit('session_sealed', { clarificationCount: 1 });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].source, 'low_clarification');
    });

    it('skips low_clarification when count is too high', () => {
      const calls = emit('session_sealed', { clarificationCount: 5 });
      assert.equal(calls.length, 0);
    });
  });

  describe('exploration (开拓力)', () => {
    it('awards tool_category_breadth for mcp tool use', () => {
      const calls = emit('tool_used', { category: 'mcp' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].source, 'tool_category_breadth');
    });

    it('awards tool_category_breadth for skill tool use', () => {
      const calls = emit('tool_used', { category: 'skill' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].source, 'tool_category_breadth');
    });

    it('ignores regular tool use', () => {
      const calls = emit('tool_used', { category: 'builtin' });
      assert.equal(calls.length, 0);
    });
  });

  describe('shadow dimensions (AC-D3)', () => {
    it('awards feedback_applied on review_submitted', () => {
      const calls = emit('review_submitted');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].source, 'feedback_applied');
    });

    it('awards direction_confirmed on task with low clarifications', () => {
      const calls = emit('task_completed', { clarificationCount: 0 });
      const sources = calls.map((c) => c.source);
      assert.ok(sources.includes('direction_confirmed'));
    });
  });

  describe('ignored events', () => {
    it('silently ignores unknown event types', () => {
      const calls = emit('message_sent', {});
      assert.equal(calls.length, 0);
    });

    it('does NOT react to per-responder multi_mention_completed', () => {
      const calls = emit('multi_mention_completed', { participants: ['a', 'b'] });
      assert.equal(calls.length, 0);
    });

    it('does NOT react to per-responder deep_collab_completed', () => {
      const calls = emit('deep_collab_completed', { participants: ['a', 'b', 'c'] });
      assert.equal(calls.length, 0);
    });
  });

  describe('dispose', () => {
    it('unsubscribes from bus', () => {
      projector.dispose();
      const calls = emit('multi_mention_dispatched');
      assert.equal(calls.length, 0);
    });
  });
});
