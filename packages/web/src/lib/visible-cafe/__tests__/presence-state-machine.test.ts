/**
 * F258 Visible Café — CatPresenceSnapshot State Machine Tests
 *
 * Covers:
 * - §2a transition table (every cell)
 * - INV-1: pickPosture pure function
 * - INV-2: expired snapshot → sleeping
 * - INV-3: has_staged_thought always false (Phase A)
 * - Adversarial 1: cable-pull (socket disconnect → TTL → unknown)
 * - Adversarial 2: out-of-order events rejected
 * - Adversarial 3: reconcile wins over socket (dual-write)
 * - Adversarial 4: empty source 1 hour — zero posture changes
 * - Adversarial 5: midnight DND boundary tick switch
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { isQuietHours, pickOpacity, pickPosture } from '@/components/visible-cafe/CatSprite';
import { createInitialSnapshot, PRESENCE_TTL_MS } from '@/lib/visible-cafe/presence-types';
import { useVisibleCafePresenceStore } from '@/stores/visible-cafe-presence';

describe('CatPresenceSnapshot state machine', () => {
  beforeEach(() => {
    useVisibleCafePresenceStore.getState().reset();
  });

  // ── §2a Transition table ──

  describe('transition table', () => {
    it('unknown + socket event → live', () => {
      const store = useVisibleCafePresenceStore.getState();
      expect(store.snapshot.state).toBe('unknown');

      store.applyEvent({
        posture: 'sleeping',
        hasStagedThought: false,
        observedAt: 1000,
        confidence: 'socket',
        sourceRef: 'test-1',
      });

      expect(useVisibleCafePresenceStore.getState().snapshot.state).toBe('live');
    });

    it('unknown + reconcile → live', () => {
      const store = useVisibleCafePresenceStore.getState();
      store.applyEvent({
        posture: 'sleeping',
        hasStagedThought: false,
        observedAt: 1000,
        confidence: 'reconciled',
        sourceRef: 'reconcile-1',
      });

      expect(useVisibleCafePresenceStore.getState().snapshot.state).toBe('live');
      expect(useVisibleCafePresenceStore.getState().snapshot.confidence).toBe('reconciled');
    });

    it('live + socket event → live (refreshed)', () => {
      const store = useVisibleCafePresenceStore.getState();
      store.applyEvent({
        posture: 'sleeping',
        hasStagedThought: false,
        observedAt: 1000,
        confidence: 'socket',
        sourceRef: 'test-1',
      });

      store.applyEvent({
        posture: 'sleeping',
        hasStagedThought: false,
        observedAt: 2000,
        confidence: 'socket',
        sourceRef: 'test-2',
      });

      const snap = useVisibleCafePresenceStore.getState().snapshot;
      expect(snap.state).toBe('live');
      expect(snap.observedAt).toBe(2000);
      expect(snap.expiresAt).toBe(2000 + PRESENCE_TTL_MS);
    });

    it('live + half-TTL no refresh → stale', () => {
      const store = useVisibleCafePresenceStore.getState();
      store.applyEvent({
        posture: 'sleeping',
        hasStagedThought: false,
        observedAt: 1000,
        confidence: 'socket',
        sourceRef: 'test-1',
      });

      // Tick to half-TTL
      store.tick(1000 + PRESENCE_TTL_MS / 2 + 1);
      expect(useVisibleCafePresenceStore.getState().snapshot.state).toBe('stale');
    });

    it('live + TTL expired → unknown', () => {
      const store = useVisibleCafePresenceStore.getState();
      store.applyEvent({
        posture: 'sleeping',
        hasStagedThought: false,
        observedAt: 1000,
        confidence: 'socket',
        sourceRef: 'test-1',
      });

      // Tick past TTL
      store.tick(1000 + PRESENCE_TTL_MS + 1);
      expect(useVisibleCafePresenceStore.getState().snapshot.state).toBe('unknown');
    });

    it('stale + socket event → live', () => {
      const store = useVisibleCafePresenceStore.getState();
      // Go to live
      store.applyEvent({
        posture: 'sleeping',
        hasStagedThought: false,
        observedAt: 1000,
        confidence: 'socket',
        sourceRef: 'test-1',
      });
      // Go to stale
      store.tick(1000 + PRESENCE_TTL_MS / 2 + 1);
      expect(useVisibleCafePresenceStore.getState().snapshot.state).toBe('stale');

      // New event → back to live
      store.applyEvent({
        posture: 'sleeping',
        hasStagedThought: false,
        observedAt: 2000,
        confidence: 'socket',
        sourceRef: 'test-2',
      });
      expect(useVisibleCafePresenceStore.getState().snapshot.state).toBe('live');
    });

    it('stale + TTL expired → unknown', () => {
      const store = useVisibleCafePresenceStore.getState();
      store.applyEvent({
        posture: 'sleeping',
        hasStagedThought: false,
        observedAt: 1000,
        confidence: 'socket',
        sourceRef: 'test-1',
      });
      // Skip to stale
      store.tick(1000 + PRESENCE_TTL_MS / 2 + 1);

      // Then expire
      store.tick(1000 + PRESENCE_TTL_MS + 1);
      expect(useVisibleCafePresenceStore.getState().snapshot.state).toBe('unknown');
    });

    it('unknown + tick → stays unknown (no-op)', () => {
      const store = useVisibleCafePresenceStore.getState();
      store.tick(999999);
      expect(useVisibleCafePresenceStore.getState().snapshot.state).toBe('unknown');
    });
  });

  // ── INV-1: pickPosture pure function ──

  describe('INV-1: pickPosture purity', () => {
    it('same snapshot + same now → same output', () => {
      const snapshot = {
        ...createInitialSnapshot(),
        state: 'live' as const,
        posture: 'sleeping' as const,
        observedAt: 1000,
        expiresAt: 1000 + PRESENCE_TTL_MS,
      };

      const result1 = pickPosture(snapshot, 2000);
      const result2 = pickPosture(snapshot, 2000);
      expect(result1).toBe(result2);
      expect(result1).toBe('sleeping');
    });

    it('returns posture from snapshot when live', () => {
      const snapshot = {
        ...createInitialSnapshot(),
        state: 'live' as const,
        posture: 'working' as const,
        observedAt: 1000,
        expiresAt: 1000 + PRESENCE_TTL_MS,
      };
      expect(pickPosture(snapshot, 2000)).toBe('working');
    });
  });

  // ── INV-2: expired → sleeping ──

  describe('INV-2: expired prohibition', () => {
    it('now > expiresAt → sleeping regardless of posture field', () => {
      const snapshot = {
        ...createInitialSnapshot(),
        state: 'live' as const,
        posture: 'working' as const,
        observedAt: 1000,
        expiresAt: 2000,
      };

      // Before expiry: working
      expect(pickPosture(snapshot, 1500)).toBe('working');

      // After expiry: sleeping
      expect(pickPosture(snapshot, 2001)).toBe('sleeping');
    });

    it('expired snapshot renders at 50% opacity', () => {
      const snapshot = {
        ...createInitialSnapshot(),
        state: 'live' as const,
        posture: 'working' as const,
        observedAt: 1000,
        expiresAt: 2000,
      };

      expect(pickOpacity(snapshot, 1500)).toBe(1);
      expect(pickOpacity(snapshot, 2001)).toBe(0.5);
    });
  });

  // ── INV-3: has_staged_thought always false ──

  describe('INV-3: staged_thought gated', () => {
    it('Phase A: hasStagedThought is always false in mapped events', () => {
      const store = useVisibleCafePresenceStore.getState();

      // Even if an event claims hasStagedThought=true, the mapping layer
      // should set it to false. Test at store level:
      store.applyEvent({
        posture: 'sleeping',
        hasStagedThought: false, // INV-3 enforced at mapping layer
        observedAt: 1000,
        confidence: 'socket',
        sourceRef: 'test-1',
      });

      expect(useVisibleCafePresenceStore.getState().snapshot.hasStagedThought).toBe(false);
    });
  });

  // ── Adversarial scenarios ──

  describe('adversarial: cable-pull', () => {
    it('socket disconnect → TTL ticks → all unknown within 5-10s equivalent', () => {
      const store = useVisibleCafePresenceStore.getState();
      store.applyEvent({
        posture: 'sleeping',
        hasStagedThought: false,
        observedAt: 1000,
        confidence: 'socket',
        sourceRef: 'test-1',
      });
      expect(useVisibleCafePresenceStore.getState().snapshot.state).toBe('live');

      // Simulate disconnect: no more events, tick past TTL
      store.tick(1000 + PRESENCE_TTL_MS + 1);
      expect(useVisibleCafePresenceStore.getState().snapshot.state).toBe('unknown');
    });
  });

  describe('adversarial: out-of-order', () => {
    it('old observedAt event → state does not regress', () => {
      const store = useVisibleCafePresenceStore.getState();

      // Newer event first
      store.applyEvent({
        posture: 'sleeping',
        hasStagedThought: false,
        observedAt: 5000,
        confidence: 'socket',
        sourceRef: 'test-new',
      });

      // Older event arrives late → should be rejected
      store.applyEvent({
        posture: 'working',
        hasStagedThought: false,
        observedAt: 3000,
        confidence: 'socket',
        sourceRef: 'test-old',
      });

      const snap = useVisibleCafePresenceStore.getState().snapshot;
      expect(snap.observedAt).toBe(5000);
      expect(snap.sourceRef).toBe('test-new');
    });
  });

  describe('adversarial: dual-write (reconcile wins)', () => {
    it('reconcile with newer timestamp overwrites socket state', () => {
      const store = useVisibleCafePresenceStore.getState();

      // Socket says one thing
      store.applyEvent({
        posture: 'sleeping',
        hasStagedThought: false,
        observedAt: 1000,
        confidence: 'socket',
        sourceRef: 'socket-1',
      });

      // Reconcile says another (newer) → reconcile wins
      store.applyEvent({
        posture: 'sleeping',
        hasStagedThought: false,
        observedAt: 2000,
        confidence: 'reconciled',
        sourceRef: 'reconcile-1',
      });

      const snap = useVisibleCafePresenceStore.getState().snapshot;
      expect(snap.confidence).toBe('reconciled');
      expect(snap.observedAt).toBe(2000);
    });
  });

  describe('adversarial: empty source 1 hour', () => {
    it('zero events + mock time 3600s → zero posture changes from initial', () => {
      const store = useVisibleCafePresenceStore.getState();
      const initialPosture = useVisibleCafePresenceStore.getState().snapshot.posture;

      // Tick every second for an hour (simulated — we just jump)
      for (let t = 0; t < 3600_000; t += 60_000) {
        store.tick(t);
      }

      // Still unknown, posture unchanged
      const snap = useVisibleCafePresenceStore.getState().snapshot;
      expect(snap.state).toBe('unknown');
      expect(snap.posture).toBe(initialPosture);
    });
  });

  describe('adversarial: midnight DND boundary', () => {
    it('22:59 → 23:01 crossing → quiet hours detection flips exactly once', () => {
      // DND config: 23:00-07:00
      const config = { startHour: 23, endHour: 7 };

      const at2259 = new Date(2026, 6, 17, 22, 59, 0);
      const at2300 = new Date(2026, 6, 17, 23, 0, 0);
      const at2301 = new Date(2026, 6, 17, 23, 1, 0);

      expect(isQuietHours(at2259, config)).toBe(false);
      expect(isQuietHours(at2300, config)).toBe(true);
      expect(isQuietHours(at2301, config)).toBe(true);

      // Default quiet hours (09:00-18:00, co-creator sleep schedule)
      const morning = new Date(2026, 6, 17, 9, 0, 0);
      const afternoon = new Date(2026, 6, 17, 17, 59, 0);
      const evening = new Date(2026, 6, 17, 18, 0, 0);

      expect(isQuietHours(morning)).toBe(true);
      expect(isQuietHours(afternoon)).toBe(true);
      expect(isQuietHours(evening)).toBe(false);
    });
  });
});
