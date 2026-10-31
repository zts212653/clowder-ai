import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * F227 PR-1 Task 1 — terminal EventMemory schema (10 fields) guard tests.
 *
 * Source of truth: docs/discussions/2026-06-06-f227-design-gate.md
 *   "新增 EventMemory typed model，使用终态 10 字段：
 *    type, trigger, cat, threadId, messageId, timestamp, summary,
 *    cognitiveTransition, relatedHarness, confidence."
 * cognitiveTransition / relatedHarness are nullable but the KEY must exist
 * (terminal 10-field shape — writers must explicitly say "no transition" = null,
 * not forget the field).
 */

const TRIGGERS = ['human_brake', 'cat_brake', 'cat_shout', 'flywheel_selffix', 'lesson_settle'];
const TRANSITIONS = [
  'user_brake',
  'self_brake',
  'coordinate_correction',
  'capability_gap',
  'scope_correction',
  'aha',
  'repeated_need',
  'harness_internalized',
  'lesson_crystallized',
];
const CONFIDENCES = ['high', 'mid', 'low'];

/** A fully-valid 10-field record. */
function validRecord() {
  return {
    type: 'scaffold',
    trigger: 'human_brake',
    cat: 'cat-opus',
    threadId: 'thread_abc123',
    messageId: 'msg_xyz789',
    timestamp: 1717650000000,
    summary: '脚手架',
    cognitiveTransition: 'user_brake',
    relatedHarness: null,
    confidence: 'high',
  };
}

describe('F227: EventMemory types', () => {
  describe('generateEventId', () => {
    it('generates ID with evt_ prefix', async () => {
      const { generateEventId } = await import('../dist/types/event-memory.js');
      const id = generateEventId();
      assert.ok(id.startsWith('evt_'), `expected evt_ prefix, got: ${id}`);
    });

    it('generates unique IDs', async () => {
      const { generateEventId } = await import('../dist/types/event-memory.js');
      assert.notEqual(generateEventId(), generateEventId(), 'IDs should be unique');
    });
  });

  describe('isEventMemoryRecord — accepts', () => {
    it('accepts a fully-valid record', async () => {
      const { isEventMemoryRecord } = await import('../dist/types/event-memory.js');
      assert.equal(isEventMemoryRecord(validRecord()), true);
    });

    it('accepts every trigger enum value', async () => {
      const { isEventMemoryRecord } = await import('../dist/types/event-memory.js');
      for (const trigger of TRIGGERS) {
        assert.equal(isEventMemoryRecord({ ...validRecord(), trigger }), true, `trigger=${trigger}`);
      }
    });

    it('accepts every confidence enum value', async () => {
      const { isEventMemoryRecord } = await import('../dist/types/event-memory.js');
      for (const confidence of CONFIDENCES) {
        assert.equal(isEventMemoryRecord({ ...validRecord(), confidence }), true, `confidence=${confidence}`);
      }
    });

    it('accepts every cognitiveTransition enum value', async () => {
      const { isEventMemoryRecord } = await import('../dist/types/event-memory.js');
      for (const cognitiveTransition of TRANSITIONS) {
        assert.equal(
          isEventMemoryRecord({ ...validRecord(), cognitiveTransition }),
          true,
          `transition=${cognitiveTransition}`,
        );
      }
    });

    it('accepts null cognitiveTransition', async () => {
      const { isEventMemoryRecord } = await import('../dist/types/event-memory.js');
      assert.equal(isEventMemoryRecord({ ...validRecord(), cognitiveTransition: null }), true);
    });

    it('accepts relatedHarness as string array', async () => {
      const { isEventMemoryRecord } = await import('../dist/types/event-memory.js');
      assert.equal(isEventMemoryRecord({ ...validRecord(), relatedHarness: ['commit:abc', 'skill:tdd'] }), true);
    });
  });

  describe('isEventMemoryRecord — rejects non-objects', () => {
    it('rejects null / undefined / primitives / array', async () => {
      const { isEventMemoryRecord } = await import('../dist/types/event-memory.js');
      for (const bad of [null, undefined, 'x', 42, true, []]) {
        assert.equal(isEventMemoryRecord(bad), false, `value=${JSON.stringify(bad)}`);
      }
    });
  });

  describe('isEventMemoryRecord — rejects missing fields', () => {
    const ALL_FIELDS = [
      'type',
      'trigger',
      'cat',
      'threadId',
      'messageId',
      'timestamp',
      'summary',
      'cognitiveTransition',
      'relatedHarness',
      'confidence',
    ];
    for (const field of ALL_FIELDS) {
      it(`rejects record missing "${field}" key`, async () => {
        const { isEventMemoryRecord } = await import('../dist/types/event-memory.js');
        const bad = validRecord();
        delete bad[field];
        assert.equal(isEventMemoryRecord(bad), false, `missing ${field} should be invalid`);
      });
    }
  });

  describe('isEventMemoryRecord — rejects wrong types & bad enums', () => {
    it('rejects invalid trigger enum', async () => {
      const { isEventMemoryRecord } = await import('../dist/types/event-memory.js');
      assert.equal(isEventMemoryRecord({ ...validRecord(), trigger: 'bogus' }), false);
    });

    it('rejects invalid confidence enum', async () => {
      const { isEventMemoryRecord } = await import('../dist/types/event-memory.js');
      assert.equal(isEventMemoryRecord({ ...validRecord(), confidence: 'sky-high' }), false);
    });

    it('rejects invalid cognitiveTransition enum', async () => {
      const { isEventMemoryRecord } = await import('../dist/types/event-memory.js');
      assert.equal(isEventMemoryRecord({ ...validRecord(), cognitiveTransition: 'enlightenment' }), false);
    });

    it('rejects non-string type', async () => {
      const { isEventMemoryRecord } = await import('../dist/types/event-memory.js');
      assert.equal(isEventMemoryRecord({ ...validRecord(), type: 123 }), false);
    });

    it('rejects non-number timestamp', async () => {
      const { isEventMemoryRecord } = await import('../dist/types/event-memory.js');
      assert.equal(isEventMemoryRecord({ ...validRecord(), timestamp: '123' }), false);
    });

    it('rejects relatedHarness with non-string elements', async () => {
      const { isEventMemoryRecord } = await import('../dist/types/event-memory.js');
      assert.equal(isEventMemoryRecord({ ...validRecord(), relatedHarness: [1, 2] }), false);
    });

    it('rejects relatedHarness that is neither null nor array', async () => {
      const { isEventMemoryRecord } = await import('../dist/types/event-memory.js');
      assert.equal(isEventMemoryRecord({ ...validRecord(), relatedHarness: 'commit:abc' }), false);
    });
  });
});
