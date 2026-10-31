import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryBrakeCard } from '../MemoryBrakeCard';
import { useBrakes } from '../use-brakes';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: fetchMock }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => ({ nickname: '宪宪' }) }) }));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => null }));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});
const ok = (value: unknown) => Promise.resolve({ ok: true, json: async () => value });
function CursorProbe() {
  const state = useBrakes(0);
  return <output>{`${state.error ? 'error' : 'ready'}|${state.hasMore ? 'more' : 'no-more'}`}</output>;
}
describe('brake read guards', () => {
  it('an inaccessible source never offers navigation even when coordinates are in the response', async () => {
    fetchMock.mockImplementation(() => ok({ canOpen: false, title: '不可读标题', threadId: 't', messageId: 'm' }));
    await act(() =>
      root.render(
        <MemoryBrakeCard
          row={{
            key: 'k',
            sourceEventId: 'e',
            threadId: 't',
            messageId: 'm',
            timestamp: 100,
            summary: '原话',
            words: ['数学之美'],
            cats: [],
            rules: [],
          }}
          active={false}
          onSelect={() => {}}
        />,
      ),
    );
    expect(container.textContent).toContain('暂时读不到来源对话');
    expect(container.textContent).not.toContain('不可读标题');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === '查看原消息 ↗')).toBe(false);
  });
  for (const nextOffset of [undefined, 0]) {
    it(`rejects a missing/non-advancing cursor (${nextOffset}) instead of allowing repeated pagination`, async () => {
      fetchMock.mockImplementation(() => ok({ events: [], meta: { hasMore: true, nextOffset } }));
      await act(() => root.render(<CursorProbe />));
      expect(container.textContent).toBe('error|no-more');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }
});
