import type { InvocationTrajectorySummary } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FirstOutputSource } from '../FirstOutputSource';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: api }));
const summary = {
  sessionId: 'session',
  invocationId: 'inv',
  firstAssistantOutputEvidence: {
    status: 'oversized',
    role: 'assistant',
    complete: true,
    byteLength: 50000,
    source: { sessionId: 'session', invocationId: 'inv', firstEventNo: 8, lastEventNo: 9, eventCount: 2 },
  },
} as InvocationTrajectorySummary;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  api.mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const response = (body: unknown) => ({ ok: true, json: async () => body });
async function click(text: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === text);
  expect(button).toBeDefined();
  await act(async () => button?.click());
}

it('does no automatic read, then drills exact bounded raw pages and 8k source slices', async () => {
  const first = 'x'.repeat(8000);
  api
    .mockResolvedValueOnce(
      response({ events: [{ eventNo: 8, invocationId: 'inv', oversized: true }], nextCursor: { eventNo: 9 } }),
    )
    .mockResolvedValueOnce(
      response({ eventNo: 8, eventSlice: first, charOffset: 0, totalChars: 8004, nextCharOffset: 8000 }),
    )
    .mockResolvedValueOnce(response({ eventNo: 8, eventSlice: '末尾原文', charOffset: 8000, totalChars: 8004 }))
    .mockResolvedValueOnce(
      response({
        events: [
          { eventNo: 9, invocationId: 'inv', sessionId: 'session', event: { type: 'text', content: '下一条原文' } },
        ],
      }),
    );
  await act(async () => root.render(<FirstOutputSource summary={summary} />));
  expect(api).not.toHaveBeenCalled();
  await click('查看首条输出记录');
  expect(api.mock.calls[0][0]).toBe('/api/sessions/session/events?view=raw&cursor=8&limit=1');
  expect(api.mock.calls[1][0]).toBe('/api/sessions/session/events?view=raw&cursor=8&limit=1&charOffset=0');
  expect(container.querySelector('pre')?.textContent).toBe(first);
  await click('继续读取这条记录');
  expect(api.mock.calls[2][0]).toContain('charOffset=8000');
  expect(container.querySelector('pre')?.textContent).toBe('末尾原文');
  await click('下一条来源记录');
  expect(api.mock.calls[3][0]).toBe('/api/sessions/session/events?view=raw&cursor=9&limit=1');
  expect(container.textContent).toContain('下一条原文');
});

it('does not expose a different invocation or make a char drill on its oversized record', async () => {
  api.mockResolvedValue(response({ events: [{ eventNo: 8, invocationId: 'other', oversized: true }] }));
  await act(async () => root.render(<FirstOutputSource summary={summary} />));
  await click('查看首条输出记录');
  expect(container.textContent).toContain('来源记录暂时读取失败');
  expect(api).toHaveBeenCalledTimes(1);
  expect(container.querySelector('pre')).toBeNull();
});

it('does not offer a source drill for evidence belonging to another session', async () => {
  await act(async () => root.render(<FirstOutputSource summary={{ ...summary, sessionId: 'other' }} />));
  expect(container.querySelector('button')).toBeNull();
  expect(api).not.toHaveBeenCalled();
});

it('keeps denied reads and incomplete or malformed slices unavailable', async () => {
  for (const bad of [
    { ok: false },
    response({ eventNo: 8, eventSlice: 'wrong offset', charOffset: 1, totalChars: 13 }),
    response({ eventNo: 8, eventSlice: 'missing tail', charOffset: 0, totalChars: 999 }),
  ]) {
    api
      .mockReset()
      .mockResolvedValueOnce(response({ events: [{ eventNo: 8, invocationId: 'inv', oversized: true }] }))
      .mockResolvedValueOnce(bad);
    await act(async () => root.render(<FirstOutputSource summary={summary} />));
    await click('查看首条输出记录');
    expect(container.textContent).toContain('来源记录暂时读取失败');
    expect(container.querySelector('pre')).toBeNull();
  }
});

it('discards a delayed source response after the selected invocation changes', async () => {
  let resolve!: (value: ReturnType<typeof response>) => void;
  api.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await act(async () => root.render(<FirstOutputSource summary={summary} />));
  await click('查看首条输出记录');
  await act(async () => root.render(<FirstOutputSource summary={{ ...summary, invocationId: 'other' }} />));
  await act(async () =>
    resolve(response({ events: [{ eventNo: 8, invocationId: 'inv', event: { content: '旧执行不得回写' } }] })),
  );
  expect(container.textContent).not.toContain('旧执行不得回写');
  expect(container.querySelector('pre')).toBeNull();
});
