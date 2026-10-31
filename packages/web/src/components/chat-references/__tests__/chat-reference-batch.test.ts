import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let batch: typeof import('../chat-reference-batch').chatReferenceBatch;
let unsubscribe: Array<() => void> = [];
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  batch = (await import('../chat-reference-batch')).chatReferenceBatch;
});
afterEach(() => {
  unsubscribe.forEach((stop) => stop());
  unsubscribe = [];
  vi.useRealTimers();
  vi.resetAllMocks();
});
const payload = (threadId: string, target: unknown) =>
  Response.json({ groups: [{ threadId, results: [{ reference: 'same.md', target }] }] });
it('deduplicates subscribers which join while the shared request is still in flight', async () => {
  let complete!: (response: Response) => void;
  vi.mocked(apiFetch).mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  unsubscribe.push(batch.subscribe('thread_inflight', 'same.md', () => {}));
  await vi.advanceTimersByTimeAsync(10);
  unsubscribe.push(batch.subscribe('thread_inflight', 'same.md', () => {}));
  await vi.advanceTimersByTimeAsync(10);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  complete(payload('thread_inflight', { kind: 'missing' }));
  await vi.advanceTimersByTimeAsync(1);
  expect(batch.read('thread_inflight', 'same.md')).toEqual({ kind: 'missing' });
});
it('refreshes visible stale entries together on focus and isolates identical paths in different threads', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_url, options) => {
    const { groups } = JSON.parse(String(options?.body));
    return Response.json({
      groups: groups.map((group: { threadId: string; references: string[] }) => ({
        threadId: group.threadId,
        results: group.references.map((reference) => ({
          reference,
          target: group.threadId === 'thread_missing' ? { kind: 'missing' } : null,
        })),
      })),
    });
  });
  unsubscribe.push(batch.subscribe('thread_missing', 'same.md', () => {}));
  unsubscribe.push(batch.subscribe('thread_unknown', 'same.md', () => {}));
  await vi.advanceTimersByTimeAsync(10);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(batch.read('thread_missing', 'same.md')).toEqual({ kind: 'missing' });
  expect(batch.read('thread_unknown', 'same.md')).toBeNull();
  await vi.advanceTimersByTimeAsync(5001);
  window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(10);
  expect(apiFetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[1][1]?.body)).groups).toHaveLength(1);
});
it('bounds each batch while draining all active messages without dropping later threads', async () => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ groups: [] }));
  for (let thread = 0; thread < 10; thread++)
    for (let file = 0; file < 70; file++)
      unsubscribe.push(batch.subscribe(`thread_${thread}`, `file${file}.md`, () => {}));
  await vi.advanceTimersByTimeAsync(100);
  const submitted = vi.mocked(apiFetch).mock.calls.flatMap(([, options]) => {
    const { groups } = JSON.parse(String(options?.body));
    expect(groups.length).toBeLessThanOrEqual(8);
    expect(
      groups.reduce((total: number, g: { references: string[] }) => total + g.references.length, 0),
    ).toBeLessThanOrEqual(128);
    return groups.flatMap((g: { threadId: string; references: string[] }) => {
      expect(g.references.length).toBeLessThanOrEqual(64);
      return g.references.map((ref) => g.threadId + ':' + ref);
    });
  });
  expect(new Set(submitted).size).toBe(700);
});

it('drops queued lookups whose last visible consumer leaves before the request starts', async () => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ groups: [] }));
  const stop = batch.subscribe('thread_left_viewport', 'docs/hidden.md', () => {});
  stop();
  await vi.advanceTimersByTimeAsync(10);
  expect(apiFetch).not.toHaveBeenCalled();
  unsubscribe.push(batch.subscribe('thread_left_viewport', 'docs/hidden.md', () => {}));
  await vi.advanceTimersByTimeAsync(10);
  expect(apiFetch).toHaveBeenCalledTimes(1);
});
