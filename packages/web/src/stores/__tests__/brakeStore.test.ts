/**
 * F085 Phase 6 — brakeStore behavior tests (AC4/AC6 + legacy-mode regression).
 *
 * Covers the gentle/hardcore event propagation the API tests cannot see:
 * - mode travels with brake:trigger → modal branch correct even when the
 *   settings panel was never opened in this page session
 * - MISSING mode (older API without Phase 6) must preserve the legacy
 *   hardcore contract — never silently downgrade to one-click dismiss
 * - saveSettings reverts the optimistic update when the server rejects
 *   (including TD110 persist failures surfaced as error payloads)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import { useBrakeStore } from '../brakeStore';

const INITIAL = useBrakeStore.getState();

const TRIGGER = { level: 2 as const, activeMinutes: 95, nightMode: false, timestamp: 1_000 };

beforeEach(() => {
  useBrakeStore.setState(INITIAL, true);
  mockApiFetch.mockReset();
});

describe('brakeStore.show — mode propagation with the trigger (AC6)', () => {
  it('gentle event sets gentle mode + trigger fields', () => {
    useBrakeStore.getState().show({ ...TRIGGER, mode: 'gentle' });
    const s = useBrakeStore.getState();
    expect(s.visible).toBe(true);
    expect(s.level).toBe(2);
    expect(s.activeMinutes).toBe(95);
    expect(s.nightMode).toBe(false);
    expect(s.settingsMode).toBe('gentle');
    expect(s.bypassDisabled).toBe(false);
  });

  it('hardcore event sets hardcore mode', () => {
    useBrakeStore.getState().show({ ...TRIGGER, mode: 'hardcore' });
    expect(useBrakeStore.getState().settingsMode).toBe('hardcore');
  });

  it('event mode overrides the setting loaded by the settings panel', () => {
    useBrakeStore.setState({ settingsMode: 'hardcore' });
    useBrakeStore.getState().show({ ...TRIGGER, mode: 'gentle' });
    expect(useBrakeStore.getState().settingsMode).toBe('gentle');
  });
});

describe('brakeStore.show — missing mode preserves legacy hardcore (regression)', () => {
  it('missing mode renders hardcore even though the store default is gentle', () => {
    // Phase 6 store default is gentle; an old API emitting brake:trigger
    // without mode must not inherit it
    expect(useBrakeStore.getState().settingsMode).toBe('gentle');
    useBrakeStore.getState().show({ ...TRIGGER });
    expect(useBrakeStore.getState().settingsMode).toBe('hardcore');
  });

  it('missing mode does NOT keep a stale gentle from the settings panel', () => {
    // The exact reported downgrade: panel loaded gentle, then an old-API
    // trigger without mode arrives → prior hardcore contract must hold
    useBrakeStore.setState({ settingsMode: 'gentle' });
    useBrakeStore.getState().show({ ...TRIGGER });
    expect(useBrakeStore.getState().settingsMode).toBe('hardcore');
  });
});

describe('brakeStore.loadSettings', () => {
  it('populates settings from the server and defaults mode to gentle when absent', async () => {
    mockApiFetch.mockResolvedValue({
      json: async () => ({ enabled: true, thresholdMinutes: 120 }),
    });
    await useBrakeStore.getState().loadSettings();
    const s = useBrakeStore.getState();
    expect(s.settingsEnabled).toBe(true);
    expect(s.settingsThreshold).toBe(120);
    expect(s.settingsMode).toBe('gentle');
  });
});

describe('brakeStore.saveSettings — rejection reverts optimistic update', () => {
  it('reverts on server error payload (TD110 persist failure)', async () => {
    useBrakeStore.setState({ settingsEnabled: false, settingsMode: 'gentle', settingsThreshold: 90 });
    mockApiFetch.mockResolvedValue({
      json: async () => ({ error: 'Failed to persist brake settings', code: 'PERSIST_FAILED' }),
    });

    await useBrakeStore.getState().saveSettings({ enabled: true, mode: 'hardcore' });

    const s = useBrakeStore.getState();
    expect(s.settingsEnabled).toBe(false);
    expect(s.settingsMode).toBe('gentle');
  });

  it('reverts on network failure', async () => {
    useBrakeStore.setState({ settingsEnabled: false, settingsMode: 'gentle', settingsThreshold: 90 });
    mockApiFetch.mockRejectedValue(new Error('network down'));

    await useBrakeStore.getState().saveSettings({ enabled: true });

    expect(useBrakeStore.getState().settingsEnabled).toBe(false);
  });
});
