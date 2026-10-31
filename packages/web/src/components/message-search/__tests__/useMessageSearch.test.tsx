import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useMessageSearch } from '../useMessageSearch';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let hook: ReturnType<typeof useMessageSearch>;
function Host({ threadId }: { threadId: string }) {
  hook = useMessageSearch(threadId);
  return null;
}
function deferred() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const result = (query: string) => ({
  searchId: `search-${query}`,
  query,
  results: [],
  meta: { scope: 'thread', sort: 'time' },
});
const ok = (query: string) => ({ ok: true, json: async () => result(query) }) as Response;

describe('common human message query adapter', () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.mocked(apiFetch).mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  async function mount(threadId = 'original') {
    await act(async () => root.render(<Host threadId={threadId} />));
  }
  it('uses the same message service, hybrid strategy and chronological current-thread default', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok('琴键 & 回来'));
    await mount();
    await act(async () => hook.search('琴键 & 回来'));
    expect(apiFetch).toHaveBeenCalledOnce();
    const url = new URL(vi.mocked(apiFetch).mock.calls[0][0], 'https://example.test');
    expect(url.pathname).toBe('/api/evidence/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      resultUnit: 'message',
      q: '琴键 & 回来',
      threadId: 'original',
      messageSort: 'time',
      mode: 'hybrid',
    });
    expect(hook.status).toBe('ready');
    expect(hook.response?.query).toBe('琴键 & 回来');
  });
  it('global and relevance selectors requery without choosing a target', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok('意思'));
    await mount();
    await act(async () => hook.search('意思', 'global', 'relevance'));
    const url = new URL(vi.mocked(apiFetch).mock.calls[0][0], 'https://example.test');
    expect(url.searchParams.has('threadId')).toBe(false);
    expect(url.searchParams.get('messageSort')).toBe('relevance');
    expect(url.searchParams.get('mode')).toBe('hybrid');
  });
  it('a late response cannot replace a newer query', async () => {
    const old = deferred();
    const latest = deferred();
    vi.mocked(apiFetch).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    await mount();
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = hook.search('旧');
    });
    act(() => {
      second = hook.search('新');
    });
    await act(async () => {
      latest.resolve(ok('新'));
      await second;
    });
    await act(async () => {
      old.resolve(ok('旧'));
      await first;
    });
    expect(hook.response?.query).toBe('新');
    expect(hook.status).toBe('ready');
  });
  it('changing thread retires pending query and clears old results', async () => {
    const old = deferred();
    vi.mocked(apiFetch).mockReturnValueOnce(old.promise);
    await mount();
    let request!: Promise<void>;
    act(() => {
      request = hook.search('旧线程');
    });
    await mount('next');
    await act(async () => {
      old.resolve(ok('旧线程'));
      await request;
    });
    expect(hook.status).toBe('idle');
    expect(hook.response).toBeUndefined();
  });
  it('distinguishes denied scope from a failed read and never renders them as empty success', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ ok: false, status: 403 } as Response);
    await mount();
    await act(async () => hook.search('query'));
    expect(hook.status).toBe('forbidden');
    expect(hook.response).toBeUndefined();
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('connection lost'));
    await act(async () => hook.search('query'));
    expect(hook.status).toBe('error');
    vi.mocked(apiFetch).mockResolvedValueOnce(ok('query'));
    await act(async () => hook.retry());
    expect(hook.status).toBe('ready');
  });
  it('does not send empty queries', async () => {
    await mount();
    await act(async () => hook.search('  '));
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
