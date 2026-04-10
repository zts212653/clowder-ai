/**
 * F099: Hub accordion navigation regression tests
 * Tests entry-point routing, group lookup, and resolveRequestedHubTab.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

// Mock heavy deps so CatCafeHub can be imported without full React tree
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], getCatById: () => undefined, refresh: () => Promise.resolve([]) }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

const { resolveRequestedHubTab, findGroupForTab } = await import('../CatCafeHub');

describe('F099 Hub navigation', () => {
  beforeEach(() => {
    useChatStore.setState({ hubState: null });
  });

  describe('openHub entry point routing', () => {
    it('openHub() without tab sets hubState with no tab (accordion home)', () => {
      useChatStore.getState().openHub();
      const state = useChatStore.getState().hubState;
      expect(state?.open).toBe(true);
      expect(state?.tab).toBeUndefined();
    });

    it('openHub("commands") deep-links to specific tab', () => {
      useChatStore.getState().openHub('commands');
      const state = useChatStore.getState().hubState;
      expect(state).toEqual({ open: true, tab: 'commands' });
    });

    it('openHub("system") deep-links to system tab', () => {
      useChatStore.getState().openHub('system');
      expect(useChatStore.getState().hubState).toEqual({ open: true, tab: 'system' });
    });
  });

  describe('findGroupForTab', () => {
    it('finds cats group for "cats"', () => {
      const group = findGroupForTab('cats');
      expect(group).toBeDefined();
      expect(group?.id).toBe('cats');
    });

    it('finds settings group for "accounts"', () => {
      const group = findGroupForTab('accounts');
      expect(group).toBeDefined();
      expect(group?.id).toBe('settings');
    });

    it('finds cats group for "capabilities"', () => {
      const group = findGroupForTab('capabilities');
      expect(group).toBeDefined();
      expect(group?.id).toBe('cats');
    });

    it('finds settings group for "voice"', () => {
      const group = findGroupForTab('voice');
      expect(group).toBeDefined();
      expect(group?.id).toBe('settings');
    });

    it('finds cats group for "leaderboard"', () => {
      const group = findGroupForTab('leaderboard');
      expect(group).toBeDefined();
      expect(group?.id).toBe('cats');
    });

    it('finds monitor group for "commands"', () => {
      const group = findGroupForTab('commands');
      expect(group).toBeDefined();
      expect(group?.id).toBe('monitor');
    });

    it('finds monitor group for "rescue"', () => {
      const group = findGroupForTab('rescue');
      expect(group).toBeDefined();
      expect(group?.id).toBe('monitor');
    });

    it('returns undefined for unknown tab', () => {
      expect(findGroupForTab('nonexistent')).toBeUndefined();
    });

    it('does not expose a standalone strategy tab after member editor unification', () => {
      expect(findGroupForTab('strategy')).toBeUndefined();
    });
  });

  describe('resolveRequestedHubTab', () => {
    const mockGetCatById = (id: string) => (id === 'opus' || id === 'sonnet' ? { id } : undefined);

    it('maps "quota" to "routing"', () => {
      expect(resolveRequestedHubTab('quota', mockGetCatById)).toBe('routing');
    });

    it('maps cat id to "cats"', () => {
      expect(resolveRequestedHubTab('opus', mockGetCatById)).toBe('cats');
    });

    it('passes through known tab ids', () => {
      expect(resolveRequestedHubTab('commands', mockGetCatById)).toBe('commands');
      expect(resolveRequestedHubTab('governance', mockGetCatById)).toBe('governance');
    });
  });
});
