/**
 * F194 Phase Z10 AC-Z28 — persist + restore activeInvocations across F5.
 *
 * Bug (R14): F5 reload → store starts with `hasActiveInvocation=false` +
 * `activeInvocations={}` (defaults). First paint shows "猫状态空闲 + 没 cancel
 * 按钮". `fetchQueue` fires async and updates state ~100ms-seconds later →
 * re-render shows "active" — but user sees the fake-idle gap.
 *
 * Fix: extend IDB snapshot to include active state so F5 first paint shows
 * last-known active state immediately (optimistic). `fetchQueue` continues
 * to authoritative-refresh later.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { _resetDBForTest, loadThreadActiveState, saveThreadActiveState } from '../offline-store';

describe('F194 Phase Z10 AC-Z28 — offline-store active state round-trip', () => {
  beforeEach(async () => {
    await _resetDBForTest();
  });

  it('saves and loads hasActiveInvocation + activeInvocations for a thread', async () => {
    const threadId = 'thread-z10-test';
    const activeState = {
      hasActiveInvocation: true,
      activeInvocations: {
        'inv-1': { catId: 'codex', mode: 'execute', startedAt: 1000 },
        'inv-2': { catId: 'opus-47', mode: 'execute', startedAt: 2000 },
      },
    };

    await saveThreadActiveState(threadId, activeState);
    const loaded = await loadThreadActiveState(threadId);

    expect(loaded).not.toBeNull();
    expect(loaded?.hasActiveInvocation).toBe(true);
    expect(loaded?.activeInvocations).toEqual(activeState.activeInvocations);
  });

  it('returns null for unknown thread', async () => {
    const loaded = await loadThreadActiveState('thread-never-seen');
    expect(loaded).toBeNull();
  });

  it('overwrites previous snapshot when saved again', async () => {
    const threadId = 'thread-z10-overwrite';
    await saveThreadActiveState(threadId, {
      hasActiveInvocation: true,
      activeInvocations: { 'inv-old': { catId: 'codex', mode: 'execute' } },
    });
    await saveThreadActiveState(threadId, {
      hasActiveInvocation: false,
      activeInvocations: {},
    });

    const loaded = await loadThreadActiveState(threadId);
    expect(loaded?.hasActiveInvocation).toBe(false);
    expect(loaded?.activeInvocations).toEqual({});
  });

  it('persists activeInvocations even when hasActiveInvocation is false (no active)', async () => {
    // Some callers may want to clear the snapshot when state goes idle so F5
    // doesn't show stale "active" — save with hasActive=false + empty map.
    const threadId = 'thread-z10-idle';
    await saveThreadActiveState(threadId, {
      hasActiveInvocation: false,
      activeInvocations: {},
    });
    const loaded = await loadThreadActiveState(threadId);
    expect(loaded?.hasActiveInvocation).toBe(false);
  });
});
