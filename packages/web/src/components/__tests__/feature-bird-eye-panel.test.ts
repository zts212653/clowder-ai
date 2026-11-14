// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionControlPage } from '@/components/mission-control/MissionControlPage';
import { useMissionControlStore } from '@/stores/missionControlStore';
import {
  createMissionControlMockBackend,
  flush,
  type MissionControlMockBackend,
} from './mission-control-page.test-helpers';

const mockApiFetch = vi.hoisted(() => vi.fn());

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href, ...rest }, children),
}));

vi.mock('@/components/ThreadSidebar', () => ({
  ThreadSidebar: () => React.createElement('aside', { 'data-testid': 'thread-sidebar' }),
}));

describe('extractFeatureId', () => {
  let extractFeatureId: (tags: readonly string[]) => string;

  beforeAll(async () => {
    const mod = await import('@/components/mission-control/FeatureBirdEyePanel');
    extractFeatureId = mod.extractFeatureId;
  });

  it('extracts from feature:fxxx format (docs-backlog import)', () => {
    expect(extractFeatureId(['source:docs-backlog', 'feature:f058', 'status:spec'])).toBe('F058');
  });

  it('extracts from bare F058 tag', () => {
    expect(extractFeatureId(['F058', 'other-tag'])).toBe('F058');
  });

  it('normalizes case to uppercase', () => {
    expect(extractFeatureId(['feature:f049'])).toBe('F049');
  });

  it('returns Untagged when no feature tag found', () => {
    expect(extractFeatureId(['source:docs-backlog', 'status:spec'])).toBe('Untagged');
  });

  it('returns Untagged for empty tags', () => {
    expect(extractFeatureId([])).toBe('Untagged');
  });
});

describe('MissionControlPage — Feature row list', () => {
  let container: HTMLDivElement;
  let root: Root;
  let backend: MissionControlMockBackend;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    backend = createMissionControlMockBackend();
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => backend.handleRequest(path, init));
    useMissionControlStore.setState({
      items: [],
      loading: false,
      submitting: false,
      selectedItemId: null,
      selectedPhase: 'coding',
      error: null,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('groups items by feature:fxxx tag and shows feature rows', async () => {
    const now = Date.now();
    backend.setItems([
      {
        id: 'bird-1',
        userId: 'default-user',
        title: 'Phase A',
        summary: 'S',
        priority: 'p1',
        tags: ['source:docs-backlog', 'feature:f058', 'status:spec'],
        status: 'done',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        doneAt: now,
        audit: [],
      },
      {
        id: 'bird-2',
        userId: 'default-user',
        title: 'Phase B',
        summary: 'S',
        priority: 'p1',
        tags: ['source:docs-backlog', 'feature:f058', 'status:spec'],
        status: 'dispatched',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        dispatchedAt: now,
        dispatchedThreadId: 'thread-bird',
        dispatchedThreadPhase: 'coding',
        audit: [],
      },
      {
        id: 'bird-3',
        userId: 'default-user',
        title: 'Other feature',
        summary: 'S',
        priority: 'p2',
        tags: ['source:docs-backlog', 'feature:f049'],
        status: 'open',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        audit: [],
      },
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const rowList = container.querySelector('[data-testid="mc-feature-row-list"]');
    expect(rowList).not.toBeNull();

    const f049 = container.querySelector('[data-testid="mc-feature-row-F049"]');
    expect(f049).not.toBeNull();
    expect(f049?.textContent).toContain('F049');
  });

  it('separates all-done features into collapsible done section', async () => {
    const now = Date.now();
    backend.setItems([
      {
        id: 'active-1',
        userId: 'default-user',
        title: 'Active task',
        summary: 'S',
        priority: 'p1',
        tags: ['feature:f060'],
        status: 'dispatched',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        dispatchedAt: now,
        dispatchedThreadId: 'thread-1',
        dispatchedThreadPhase: 'coding',
        audit: [],
      },
      {
        id: 'done-1',
        userId: 'default-user',
        title: 'Done task A',
        summary: 'S',
        priority: 'p1',
        tags: ['feature:f049'],
        status: 'done',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        doneAt: now,
        audit: [],
      },
      {
        id: 'done-2',
        userId: 'default-user',
        title: 'Done task B',
        summary: 'S',
        priority: 'p2',
        tags: ['feature:f049'],
        status: 'done',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        doneAt: now,
        audit: [],
      },
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    // F060 (active) should be visible as a feature row
    const f060 = container.querySelector('[data-testid="mc-feature-row-F060"]');
    expect(f060).not.toBeNull();

    // Done section should exist
    const doneSection = container.querySelector('[data-testid="mc-feature-done-section"]');
    expect(doneSection).not.toBeNull();
    expect(doneSection?.textContent).toContain('已完成');

    // F049 details should NOT be visible before expanding
    const f049Row = container.querySelector('[data-testid="mc-feature-row-F049"]');
    expect(f049Row).toBeNull();

    // Click to expand done section
    const expandBtn = doneSection?.querySelector('button');
    expect(expandBtn).not.toBeNull();
    await act(async () => {
      expandBtn?.click();
    });

    // F049 should now be visible as a feature row
    const f049After = container.querySelector('[data-testid="mc-feature-row-F049"]');
    expect(f049After).not.toBeNull();
    expect(f049After?.textContent).toContain('F049');
  });

  it('shows feature name extracted from item title', async () => {
    const now = Date.now();
    backend.setItems([
      {
        id: 'name-1',
        userId: 'default-user',
        title: '[F058] Mission Control 增强',
        summary: 'S',
        priority: 'p1',
        tags: ['feature:f058'],
        status: 'dispatched',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        dispatchedAt: now,
        dispatchedThreadId: 'thread-1',
        dispatchedThreadPhase: 'coding',
        audit: [],
      },
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const row = container.querySelector('[data-testid="mc-feature-row-F058"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('Mission Control 增强');
  });

  it('shows thread count from title-matched threads', async () => {
    const now = Date.now();
    backend.setItems([
      {
        id: 'tc-1',
        userId: 'default-user',
        title: '[F058] Mission Control',
        summary: 'S',
        priority: 'p1',
        tags: ['feature:f058'],
        status: 'dispatched',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        dispatchedAt: now,
        dispatchedThreadId: 'thread-1',
        dispatchedThreadPhase: 'coding',
        audit: [],
      },
    ]);
    backend.setThreads([
      {
        id: 'thread-f58-a',
        title: 'f058 phase A 实现',
        createdBy: 'default-user',
        lastActiveAt: now,
        participants: ['opus'] as never[],
      },
      {
        id: 'thread-f58-b',
        title: 'f058 phase B review',
        createdBy: 'default-user',
        lastActiveAt: now,
        participants: ['codex'] as never[],
      },
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const row = container.querySelector('[data-testid="mc-feature-row-F058"]');
    expect(row).not.toBeNull();
    // Thread count badge should show 2 (from featureIds title matching)
    expect(row?.textContent).toContain('2');
  });

  it('chunks featureIds requests when >50 unique features exist', async () => {
    const now = Date.now();
    // Create 55 items across 55 different features (exceeds 50 limit)
    const manyItems = Array.from({ length: 55 }, (_, i) => {
      const fid = String(i).padStart(3, '0');
      return {
        id: `chunk-${i}`,
        userId: 'default-user',
        title: `[F${fid}] Feature ${i}`,
        summary: 'S',
        priority: 'p2' as const,
        tags: [`feature:f${fid}`],
        status: 'open' as const,
        createdBy: 'user' as const,
        createdAt: now,
        updatedAt: now,
        audit: [],
      };
    });
    backend.setItems(manyItems);
    // Add a thread matching f001
    backend.setThreads([
      {
        id: 'thread-f001',
        title: 'f001 implementation',
        createdBy: 'default-user',
        lastActiveAt: now,
        participants: ['opus'] as never[],
      },
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    // If chunking works, requests won't 400 and feature row will render
    const f001Row = container.querySelector('[data-testid="mc-feature-row-F001"]');
    expect(f001Row).not.toBeNull();
    // Thread count from title matching should show 1
    expect(f001Row?.textContent).toContain('1');
  });
});
