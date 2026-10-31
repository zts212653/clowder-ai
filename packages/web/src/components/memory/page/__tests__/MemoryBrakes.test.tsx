import type { StoredEventMemory } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryBrakes } from '../MemoryBrakes';

const { events, apiFetch } = vi.hoisted(() => ({ events: [] as StoredEventMemory[], apiFetch: vi.fn() }));
vi.mock('../use-brakes', () => ({
  useBrakes: () => ({ events, loading: false, error: false, hasMore: false, retry: vi.fn(), loadMore: vi.fn() }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => ({ nickname: '砚砚' }) }) }));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => null }));
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  events.length = 0;
  for (let index = 0; index < 10; index++)
    events.push({
      eventId: `event-${index}`,
      ownerUserId: 'owner',
      type: '喵约',
      trigger: 'human_brake',
      cat: 'codex-sol',
      threadId: 'thread-a',
      messageId: `message-${index}`,
      timestamp: 100 + index,
      summary: `喵约，原消息 ${index}。这里是完整原话。`,
      cognitiveTransition: null,
      relatedHarness: null,
      confidence: 'high',
    });
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({ title: null, canOpen: false }) });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('counts message rows once and identifies the separate selected detail while selection changes', async () => {
  await act(() => root.render(<MemoryBrakes />));
  expect(container.textContent).toContain('全部 10 条消息');
  const rows = container.querySelectorAll('[data-testid="brake-message"]');
  expect(rows).toHaveLength(10);
  expect(container.querySelectorAll('article')).toHaveLength(10);
  const detail = container.querySelector('aside[aria-label="所选拉闸详情"]');
  expect(detail).not.toBeNull();
  expect(detail?.querySelector('[data-testid="brake-detail"]')?.textContent).toContain('原消息 9');
  expect(detail?.textContent).toContain('拉闸详情');
  await act(() => (rows[1].querySelector('button') as HTMLButtonElement).click());
  expect(detail?.querySelector('[data-testid="brake-detail"]')?.textContent).toContain('原消息 8');
  expect(container.querySelectorAll('[data-testid="brake-message"]')).toHaveLength(10);
  expect(container.textContent).toContain('全部 10 条消息');
  expect(apiFetch.mock.calls.every((args: unknown[]) => args.length === 1)).toBe(true);
});
