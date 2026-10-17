import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { useMemberList } from '../useMemberList';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('../useMemberAccounts', () => ({ useMemberAccounts: () => [] }));
let state: ReturnType<typeof useMemberList>;
function Probe({ cats }: { cats: CatData[] }) {
  state = useMemberList(cats);
  return (
    <div>
      {state.defaultId} / {state.defaultError}
    </div>
  );
}
const member = (id: string) => ({ id }) as CatData;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});
it('reads the resolved default again when first registration replaces the empty roster', async () => {
  let registered = false;
  vi.mocked(apiFetch).mockImplementation(
    async () => new Response(JSON.stringify({ catId: registered ? 'a' : 'legacy' })),
  );
  await act(async () => root.render(<Probe cats={[]} />));
  registered = true;
  await act(async () => root.render(<Probe cats={[member('a')]} />));
  expect(state.defaultId).toBe('a');
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
});
for (const error of [false, true])
  it(`ignores reads started during a confirmed preference save (error=${error})`, async () => {
    let finishPut: ((response: Response) => void) | undefined;
    let finishRead: ((response: Response) => void) | undefined;
    let reads = 0;
    vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
      if (init?.method === 'PUT')
        return new Promise<Response>((resolve) => {
          finishPut = resolve;
        });
      if (++reads === 1) return new Response(JSON.stringify({ catId: 'a' }));
      return new Promise<Response>((resolve) => {
        finishRead = resolve;
      });
    });
    const cats = [member('a'), member('b')];
    await act(async () => root.render(<Probe cats={cats} />));
    await act(async () => {
      void state.saveDefault('b');
    });
    await act(async () => {
      void state.readDefault();
    });
    await act(async () => finishPut?.(new Response('{}')));
    expect(state.defaultId).toBe('b');
    await act(async () => finishRead?.(new Response(error ? 'invalid-json' : JSON.stringify({ catId: 'a' }))));
    expect(state.defaultId).toBe('b');
    expect(state.defaultError).toBeNull();
    expect(state.defaultKnown).toBe(true);
    expect(state.defaultLoading).toBe(false);
  });
