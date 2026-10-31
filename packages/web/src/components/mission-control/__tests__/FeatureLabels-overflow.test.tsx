import type { BacklogItem, CatId } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeatureBirdEyePanel } from '../FeatureBirdEyePanel';
import { FeatureRowList } from '../FeatureRowList';

vi.mock('@/hooks/useFeatureDocDetail', () => ({
  useFeatureDocDetail: () => ({ detail: null, loading: false }),
}));

const LONG_ACTIVE_FEATURE =
  'Recoverable Content Overflow Mission Control Feature Name With A Canonical Tail 必须完整保留';
const LONG_DONE_FEATURE = 'Completed Mission Control Feature Name With A Different Canonical Tail 也必须完整保留';
const LONG_LINKED_THREAD = 'F269 linked implementation thread with a long diagnostic title and canonical-tail-linked';
const LONG_MATCHED_THREAD = 'F270 title matched review thread with a long diagnostic title and canonical-tail-matched';

function backlogItem(id: string, featureId: string, title: string, status: BacklogItem['status']): BacklogItem {
  const now = Date.now();
  return {
    id,
    userId: 'default-user',
    title: `[${featureId}] ${title}`,
    summary: 'Mission Control overflow fixture',
    priority: 'p1',
    tags: [`feature:${featureId.toLowerCase()}`],
    status,
    createdBy: 'user',
    createdAt: now,
    updatedAt: now,
    audit: [],
    ...(status === 'dispatched'
      ? {
          dispatchedAt: now,
          dispatchedThreadId: `thread-${id}`,
          dispatchedThreadPhase: 'coding' as const,
        }
      : {}),
    ...(status === 'done' ? { doneAt: now } : {}),
  };
}

function thread(id: string, title: string, backlogItemId?: string) {
  return {
    id,
    title,
    lastActiveAt: Date.now(),
    participants: ['codex-sol'] as CatId[],
    backlogItemId,
  };
}

function measuredValue(container: ParentNode, value: string): HTMLElement {
  const match = Array.from(container.querySelectorAll<HTMLElement>('[data-overflow-measure="inline"]')).find(
    (element) => element.textContent === value,
  );
  expect(match, `expected a measured compact label for ${value}`).toBeTruthy();
  if (!match) throw new Error(`Missing measured compact label for ${value}`);
  return match;
}

function setInlineOverflow(element: Element) {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: 90 },
    scrollWidth: { configurable: true, value: 900 },
  });
}

async function measureOverflow(...elements: Element[]) {
  for (const element of elements) setInlineOverflow(element);
  await act(async () => window.dispatchEvent(new Event('resize')));
}

describe('F269 Mission Control compact-label recovery', () => {
  let container: HTMLDivElement;
  let root: Root;
  let writeText: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('keeps short bird-eye labels quiet and recovers active and completed names only after measured overflow', async () => {
    const active = backlogItem('active', 'F269', LONG_ACTIVE_FEATURE, 'open');
    const done = backlogItem('done', 'F270', LONG_DONE_FEATURE, 'done');

    await act(async () => {
      root.render(<FeatureBirdEyePanel items={[active, done]} threadsByBacklogId={{}} threadCountByFeature={{}} />);
    });

    const doneSection = container.querySelector<HTMLElement>('[data-testid="mc-bird-eye-done-section"]');
    const expandDone = doneSection?.querySelector<HTMLButtonElement>('button');
    await act(async () => expandDone?.click());

    const activeCard = container.querySelector<HTMLElement>('[data-testid="mc-bird-eye-feature-F269"]');
    const doneChip = container.querySelector<HTMLElement>('[data-testid="mc-bird-eye-done-chip-F270"]');
    if (!activeCard || !doneChip) throw new Error('Expected active and done bird-eye fixtures');

    const activeLabel = measuredValue(activeCard, LONG_ACTIVE_FEATURE);
    const doneLabel = measuredValue(doneChip, LONG_DONE_FEATURE);
    expect(container.querySelector('button[aria-label^="复制完整Feature 名称"]')).toBeNull();

    await measureOverflow(activeLabel, doneLabel);

    const copyActive = activeCard.querySelector<HTMLButtonElement>('button[aria-label="复制完整Feature 名称"]');
    const copyDone = doneChip.querySelector<HTMLButtonElement>('button[aria-label="复制完整Feature 名称"]');
    expect(copyActive).toBeTruthy();
    expect(copyDone).toBeTruthy();
    expect(copyActive?.className).toContain('h-6');
    expect(copyActive?.className).toContain('w-6');
    expect(copyActive?.className).not.toContain('px-2');
    expect(copyDone?.className).toContain('h-6');

    await act(async () => copyActive?.click());
    await act(async () => copyDone?.click());
    expect(writeText).toHaveBeenNthCalledWith(1, LONG_ACTIVE_FEATURE);
    expect(writeText).toHaveBeenNthCalledWith(2, LONG_DONE_FEATURE);
  });

  it('keeps the full feature-row hit target while copy remains a sibling action', async () => {
    const active = backlogItem('row-active', 'F269', LONG_ACTIVE_FEATURE, 'dispatched');
    const linked = thread('thread-row-active', LONG_LINKED_THREAD, active.id);

    await act(async () => {
      root.render(
        <FeatureRowList
          items={[active]}
          threadsByBacklogId={{ [active.id]: linked }}
          threadCountByFeature={{ F269: 1 }}
          selectedItemId={null}
          onSelectItem={vi.fn()}
        />,
      );
    });

    const row = container.querySelector<HTMLElement>('[data-testid="mc-feature-row-F269"]');
    const header = row?.querySelector<HTMLElement>('[data-feature-row-header]');
    const threadCount = row?.querySelector<HTMLElement>('[data-feature-thread-count]');
    const toggle = row?.querySelector<HTMLButtonElement>('button[data-feature-row-toggle]');
    expect(header?.className).toContain('gap-2');
    expect(header?.className).toContain('sm:gap-3');
    expect(threadCount?.className).toContain('hidden');
    expect(threadCount?.className).toContain('sm:flex');
    expect(toggle?.className).toContain('absolute');
    expect(toggle?.className).toContain('inset-0');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => toggle?.click());
    expect(row?.querySelector('[data-testid="mc-feature-detail-F269"]')).not.toBeNull();
    await act(async () => toggle?.click());
    expect(row?.querySelector('[data-testid="mc-feature-detail-F269"]')).toBeNull();

    const featureLabel = measuredValue(row ?? container, LONG_ACTIVE_FEATURE);
    await measureOverflow(featureLabel);
    const copyFeature = row?.querySelector<HTMLButtonElement>('button[aria-label="复制完整Feature 名称"]');
    expect(copyFeature).toBeTruthy();
    expect(copyFeature?.className).toContain('h-6');
    expect(copyFeature?.className).toContain('w-6');
    expect(copyFeature?.className).not.toContain('px-2');
    expect(toggle?.contains(copyFeature ?? null)).toBe(false);
    expect(container.querySelector('button button')).toBeNull();

    await act(async () => copyFeature?.click());
    expect(writeText).toHaveBeenCalledWith(LONG_ACTIVE_FEATURE);
    expect(row?.querySelector('[data-testid="mc-feature-detail-F269"]')).toBeNull();
  });

  it('recovers linked and title-matched thread names without nesting copy inside navigation links', async () => {
    const linkedItem = backlogItem('linked', 'F269', LONG_ACTIVE_FEATURE, 'dispatched');
    const matchedItem = backlogItem('matched', 'F270', 'Title matched feature', 'open');
    const linked = thread('thread-linked', LONG_LINKED_THREAD, linkedItem.id);
    const matched = thread('thread-matched', LONG_MATCHED_THREAD);

    await act(async () => {
      root.render(
        <FeatureRowList
          items={[linkedItem, matchedItem]}
          threadsByBacklogId={{ [linkedItem.id]: linked }}
          threadCountByFeature={{ F269: 1, F270: 1 }}
          threadsByFeatureId={{ F270: [matched] }}
          selectedItemId={null}
          onSelectItem={vi.fn()}
        />,
      );
    });

    for (const [threadTitle, threadId] of [
      [LONG_LINKED_THREAD, 'thread-linked'],
      [LONG_MATCHED_THREAD, 'thread-matched'],
    ] as const) {
      const featureId = threadId === 'thread-linked' ? 'F269' : 'F270';
      const toggle = container.querySelector<HTMLButtonElement>(
        `[data-testid="mc-feature-row-${featureId}"] button[data-feature-row-toggle]`,
      );
      await act(async () => toggle?.click());

      const threadLabel = measuredValue(container, threadTitle);
      await measureOverflow(threadLabel);
      const row = container.querySelector<HTMLElement>(`[data-thread-link-row="${threadId}"]`);
      const link = row?.querySelector<HTMLAnchorElement>(`a[href="/thread/${threadId}"]`);
      const copy = row?.querySelector<HTMLButtonElement>('button[aria-label="复制完整关联线程标题"]');
      expect(link).toBeTruthy();
      expect(copy).toBeTruthy();
      expect(copy?.className).toContain('h-6');
      expect(copy?.className).toContain('w-6');
      expect(link?.className).toContain('absolute');
      expect(link?.className).toContain('inset-0');
      expect(link?.contains(copy ?? null)).toBe(false);
      await act(async () => copy?.click());
      expect(writeText).toHaveBeenCalledWith(threadTitle);
    }

    expect(container.querySelector('a button')).toBeNull();
  });
});
