import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { writeShellLanguage } from '../../shell-language';
import { writeShellPresentation } from '../../shell-presentation';
import { MailboxSettledResults } from '../MailboxSettledResults';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  writeShellPresentation('v2');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.mocked(apiFetch).mockReset();
  writeShellLanguage('zh');
  writeShellPresentation('classic');
  vi.unstubAllGlobals();
});

it.each([
  ['zh', '正在准备历史结果', '正在重新读取已处理结果', '重新读取', '暂时无法读取已处理结果'],
  ['en', 'Preparing handled results', 'Refreshing handled results', 'Read again', 'Handled results are unavailable'],
] as const)('keeps one preparing notice through automatic and manual pending reads in %s', async (language, preparingText, refreshingText, rereadText, unavailableText) => {
  writeShellLanguage(language);
  const reads: { resolve: (response: Response) => void; signal?: AbortSignal | null }[] = [];
  vi.mocked(apiFetch).mockImplementation((path, init) => {
    if (String(path) === '/api/session') return Promise.resolve(Response.json({ userId: 'owner' }));
    expect(String(path)).toContain('/api/approval-hub/settled');
    return new Promise<Response>((resolve) => reads.push({ resolve, signal: init?.signal }));
  });
  const preparing = () => Response.json({ code: 'APPROVAL_HISTORY_PREPARING' }, { status: 503 });
  await act(async () =>
    root.render(
      <MailboxSettledResults ownerUserId="owner" generation={1} excludedKeys={[]} verifyCurrent={() => true} />,
    ),
  );
  await act(async () => reads[0].resolve(preparing()));
  const button = container.querySelector<HTMLButtonElement>('button');
  expect(button?.textContent).toBe(rereadText);
  expect(container.querySelectorAll('p')).toHaveLength(1);
  expect(container.textContent).toContain(preparingText);

  // Hold the next response open: an immediate mocked response hides the real 16px jump.
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(reads).toHaveLength(2);
  expect(container.textContent).toContain(preparingText);
  expect(container.textContent).not.toContain(refreshingText);
  expect(container.querySelectorAll('p')).toHaveLength(1);
  expect(container.querySelector('button')).toBe(button);

  await act(async () => button?.click());
  expect(reads).toHaveLength(3);
  expect(reads[1].signal?.aborted).toBe(true);
  expect(container.textContent).not.toContain(refreshingText);
  await act(async () => {
    reads[1].resolve(preparing()); // A superseded response cannot replace the latest read.
    reads[2].resolve(preparing());
  });
  expect(container.querySelectorAll('p')).toHaveLength(1);
  expect(container.querySelector('button')).toBe(button);

  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(reads).toHaveLength(4);
  expect(container.textContent).not.toContain(refreshingText);
  await act(async () => reads[3].resolve(Response.json({ error: 'unavailable' }, { status: 500 })));
  expect(container.textContent).toContain(unavailableText);
  expect(container.textContent).not.toContain(preparingText);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(reads).toHaveLength(4); // Ordinary failures still do not enter the preparing retry loop.
  expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
});
