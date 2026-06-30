/**
 * F252 Phase C — TrajectoryPanel feat story entry point regression.
 *
 * P1-1 fix (三次同型 bug: 入口可达性=0):
 * When a feat is selected and has trajectory data, a "🎬 Story" link must
 * render pointing to /story/feat:<featId>. Without this link, the entire
 * Phase C BFF + BirdseyeView = dead code (no production caller).
 */

import type { FeatTrajectoryProjection } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: { setCurrentThread: (id: string) => void }) => unknown) =>
    selector({ setCurrentThread: () => {} }),
}));

type DeferredCall = {
  url: string;
  resolve: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
};
const deferred: DeferredCall[] = [];

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn((url: string) => {
    return new Promise((resolve) => {
      deferred.push({ url, resolve });
    });
  }),
}));

const MOCK_PROJECTION: FeatTrajectoryProjection = {
  featId: 'F252',
  entries: [
    {
      entryId: 'split:p1',
      subjectKey: 'feat:F252',
      featId: 'F252',
      at: 1719360060000,
      kind: 'thread_split',
      source: 'event-stream',
      payload: { parentThreadId: 't1', childThreadId: 't2', proposalId: 'p1', catId: 'opus' },
    },
  ],
  countsBySource: { 'event-stream': 1, 'historical-stitched': 0, 'git-ref-snapshot': 0 },
  countsByKind: { thread_split: 1 },
  appliedEntryCount: 1,
  createdAt: 1719360000000,
  updatedAt: 1719360000000,
};

describe('TrajectoryPanel feat story entry point', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    deferred.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  it('renders 🎬 Story link pointing to /story/feat:<featId> when data is loaded', async () => {
    const { TrajectoryPanel } = await import('../TrajectoryPanel');

    await act(async () => {
      root.render(<TrajectoryPanel />);
    });

    // Resolve feat list
    const listCall = deferred.find((d) => d.url.includes('/feats'));
    expect(listCall).toBeDefined();
    await act(async () => {
      listCall!.resolve({ ok: true, json: async () => ['F252', 'F233'] });
    });

    // Select F252 by clicking the dropdown item
    // If picker isn't open, open it by focusing the input
    const input = container.querySelector('input');
    if (input) {
      await act(async () => {
        input.focus();
        input.dispatchEvent(new Event('focus', { bubbles: true }));
      });
    }
    // Find and click F252
    const allButtons = container.querySelectorAll('button');
    const featButton = Array.from(allButtons).find((b) => b.textContent === 'F252');
    if (featButton) {
      await act(async () => {
        featButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
    }

    // Resolve trajectory data
    const trajCall = deferred.find((d) => d.url.includes('/feat-trajectory/F252'));
    expect(trajCall).toBeDefined();
    await act(async () => {
      trajCall!.resolve({ ok: true, json: async () => MOCK_PROJECTION });
    });

    // Verify the 🎬 Story link exists with correct href
    const storyLink = container.querySelector('a[href*="/story/feat:"]') as HTMLAnchorElement;
    expect(storyLink).not.toBeNull();
    expect(storyLink.href).toContain('/story/feat:F252');
    expect(storyLink.textContent).toContain('Story');
    expect(storyLink.target).toBe('_blank');
  });

  it('does NOT render story link when no feat is selected', async () => {
    const { TrajectoryPanel } = await import('../TrajectoryPanel');

    await act(async () => {
      root.render(<TrajectoryPanel />);
    });

    // Resolve feat list
    const listCall = deferred.find((d) => d.url.includes('/feats'));
    await act(async () => {
      listCall!.resolve({ ok: true, json: async () => ['F252'] });
    });

    // No feat selected — no story link
    const storyLink = container.querySelector('a[href*="/story/feat:"]');
    expect(storyLink).toBeNull();
  });
});
