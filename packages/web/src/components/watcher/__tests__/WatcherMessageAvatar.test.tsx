import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolveMessageSender } from '@/lib/resolve-sender';
import { SenderAvatar } from '../../SenderAvatar';

const fetcher = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => fetcher(...args), API_URL: '' }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: (id: string) => ({ id, avatar: `/members/${id}.png` }) }),
}));

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  fetcher.mockReset();
});

function avatar(roundId?: string) {
  const sender = resolveMessageSender(
    {
      from: { kind: 'system', service: 'watcher-panel' },
      source: { connector: 'watcher-panel', label: '守望猫', icon: 'watcher', meta: { roundId } },
    },
    () => undefined,
    { name: 'You', aliases: [], mentionPatterns: [] },
  );
  return <SenderAvatar sender={sender} presentation="message" />;
}

function ledger(roundId: string, catIds: string[]) {
  return { ok: true, json: async () => ({ roundId, members: catIds.map((catId) => ({ catId, status: 'spoke' })) }) };
}

it('uses the single observer from this round in a live message and after history/reference remounts', async () => {
  fetcher.mockResolvedValue(ledger('wpr:old-sol', ['codex62-sol']));
  await act(async () => root.render(avatar('wpr:old-sol')));
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/members/codex62-sol.png');
  expect(container.querySelector('[data-watcher="true"] svg')).not.toBeNull();
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/watcher/panel/rounds/wpr%3Aold-sol');

  fetcher.mockResolvedValue(ledger('wpr:alternate', ['sonnet']));
  await act(async () => root.render(<span />));
  await act(async () => root.render(avatar('wpr:alternate')));
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/members/sonnet.png');

  fetcher.mockResolvedValue(ledger('wpr:old-sol', ['codex62-sol']));
  await act(async () => root.render(avatar('wpr:old-sol')));
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/members/codex62-sol.png');
});

it('keeps a three-member experiment anonymous even when only one member spoke', async () => {
  fetcher.mockResolvedValue({
    ok: true,
    json: async () => ({
      roundId: 'wpr:experiment',
      members: [
        { catId: 'codex62-sol', status: 'spoke' },
        { catId: 'codex61-terra', status: 'quiet' },
        { catId: 'codex62-astra', status: 'interrupted' },
      ],
    }),
  });
  await act(async () => root.render(avatar('wpr:experiment')));
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/avatars/default.png');
  expect(container.querySelector('svg')).not.toBeNull();
});

it('does not invent an observer when the round is missing or the owner read is refused', async () => {
  await act(async () => root.render(avatar()));
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValue({ ok: false });
  await act(async () => root.render(avatar('wpr:unavailable')));
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/avatars/default.png');
});

it('does not let a late reply for another round change the current avatar', async () => {
  let finish: (value: ReturnType<typeof ledger>) => void = () => {};
  fetcher.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => root.render(avatar('wpr:previous')));
  fetcher.mockResolvedValue(ledger('wpr:next', ['sonnet']));
  await act(async () => root.render(avatar('wpr:next')));
  await act(async () => finish(ledger('wpr:previous', ['codex62-sol'])));
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/members/sonnet.png');
});

it('does not keep the previous round observer when the same avatar moves to another round', async () => {
  fetcher.mockResolvedValueOnce(ledger('wpr:a', ['codex62-sol']));
  await act(async () => root.render(avatar('wpr:a')));
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/members/codex62-sol.png');
  fetcher.mockReturnValueOnce(new Promise(() => {}));
  act(() => root.render(avatar('wpr:b')));
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/avatars/default.png');
});
