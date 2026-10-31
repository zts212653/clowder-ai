/**
 * F258 Visible Café — Event Mapping Tests
 *
 * Covers:
 * - Phase A semantic ruling: all events → sleeping
 * - INV-3: has_staged_thought always false
 * - Unknown event types → no posture change
 * - threadActivityToBrightness decay
 * - hashThreadIdToPosition determinism
 */

import { describe, expect, it } from 'vitest';
import {
  hashThreadIdToPosition,
  mapAgentMessageToPresence,
  mapReconcileToPresence,
  threadActivityToBrightness,
} from '@/lib/visible-cafe/event-mapping';

describe('event mapping', () => {
  describe('mapAgentMessageToPresence', () => {
    it('maps any event to sleeping (Phase A ruling)', () => {
      const result = mapAgentMessageToPresence({ id: 'msg-1', threadId: 'thread-1', type: 'assistant' }, 1000);
      expect(result.posture).toBe('sleeping');
    });

    it('INV-3: hasStagedThought always false', () => {
      const result = mapAgentMessageToPresence(
        { id: 'msg-1', type: 'thinking' }, // Even "thinking" type → no staged thought
        1000,
      );
      expect(result.hasStagedThought).toBe(false);
    });

    it('confidence is socket', () => {
      const result = mapAgentMessageToPresence({ id: 'msg-1' }, 1000);
      expect(result.confidence).toBe('socket');
    });

    it('sourceRef uses event id when available', () => {
      const result = mapAgentMessageToPresence({ id: 'msg-42' }, 1000);
      expect(result.sourceRef).toBe('msg-42');
    });

    it('sourceRef falls back to socket:timestamp when no id', () => {
      const result = mapAgentMessageToPresence({}, 1234);
      expect(result.sourceRef).toBe('socket:1234');
    });

    it('unknown event types still map to sleeping', () => {
      const result = mapAgentMessageToPresence({ type: 'completely_unknown_type_xyz' }, 1000);
      expect(result.posture).toBe('sleeping');
      expect(result.hasStagedThought).toBe(false);
    });
  });

  describe('mapReconcileToPresence', () => {
    it('maps to sleeping with reconciled confidence', () => {
      const result = mapReconcileToPresence([{ threadId: 'thread-1', lastActivity: 1000 }], 2000);
      expect(result.posture).toBe('sleeping');
      expect(result.confidence).toBe('reconciled');
      expect(result.hasStagedThought).toBe(false);
    });

    it('empty thread list still produces sleeping', () => {
      const result = mapReconcileToPresence([], 2000);
      expect(result.posture).toBe('sleeping');
    });
  });

  describe('threadActivityToBrightness', () => {
    it('just active → brightness 1', () => {
      expect(threadActivityToBrightness(1000, 1000)).toBe(1);
    });

    it('half decay → brightness ~0.5', () => {
      const result = threadActivityToBrightness(150_000, 300_000, 300_000);
      expect(result).toBeCloseTo(0.5, 1);
    });

    it('fully decayed → brightness 0', () => {
      expect(threadActivityToBrightness(0, 300_001, 300_000)).toBe(0);
    });

    it('never active (0) → brightness 0', () => {
      expect(threadActivityToBrightness(0, 1000)).toBe(0);
    });

    it('negative lastActivity → brightness 0', () => {
      expect(threadActivityToBrightness(-1, 1000)).toBe(0);
    });
  });

  describe('hashThreadIdToPosition', () => {
    it('deterministic — same id → same position', () => {
      const pos1 = hashThreadIdToPosition('thread_abc123');
      const pos2 = hashThreadIdToPosition('thread_abc123');
      expect(pos1.x).toBe(pos2.x);
      expect(pos1.y).toBe(pos2.y);
    });

    it('different ids → different positions', () => {
      const pos1 = hashThreadIdToPosition('thread_abc123');
      const pos2 = hashThreadIdToPosition('thread_xyz789');
      // Very unlikely to collide
      expect(pos1.x === pos2.x && pos1.y === pos2.y).toBe(false);
    });

    it('positions are in [0, 1] range', () => {
      const ids = ['thread_1', 'thread_2', 'thread_long_id_with_many_chars', ''];
      for (const id of ids) {
        const pos = hashThreadIdToPosition(id);
        expect(pos.x).toBeGreaterThanOrEqual(0);
        expect(pos.x).toBeLessThanOrEqual(1);
        expect(pos.y).toBeGreaterThanOrEqual(0);
        expect(pos.y).toBeLessThanOrEqual(1);
      }
    });
  });
});
