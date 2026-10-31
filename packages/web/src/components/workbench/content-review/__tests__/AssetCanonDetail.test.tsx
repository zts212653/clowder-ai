import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { AssetCanonDetail } from '../AssetCanonDetail';
import { item, record, update } from './asset-canon.fixtures';

const { fetcher } = vi.hoisted(() => ({ fetcher: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: '', apiFetch: fetcher }));
vi.mock('@/hooks/useCatData', () => ({ getCachedCats: () => [] }));
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fetcher.mockReset().mockImplementation(async (_url, init) => {
    const command = JSON.parse(init.body).command;
    return new Response(JSON.stringify(command.action === 'read-asset' ? { ...item, uses: [] } : {}), {
      headers: { 'content-type': 'application/json' },
    });
  });
});
it('requires a reason and keeps the exact update fingerprint and operation on an uncertain keep retry', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const saved = vi.fn();
  const mutations: Record<string, unknown>[] = [];
  fetcher.mockImplementation(async (_url, init) => {
    const command = JSON.parse(init.body).command;
    if (command.action === 'read-asset') return new Response(JSON.stringify({ ...item, uses: [] }));
    mutations.push(command);
    return new Response(JSON.stringify(mutations.length === 1 ? { error: 'unknown' } : {}), {
      status: mutations.length === 1 ? 503 : 200,
    });
  });
  try {
    await act(async () =>
      root.render(
        <AssetCanonDetail
          item={item}
          update={update}
          record={record}
          threadId="film"
          candidates={[item]}
          onSaved={saved}
          onNextVersion={vi.fn()}
        />,
      ),
    );
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === '这版不换')!
        .click(),
    );
    const input = host.querySelector('input')!;
    expect(input.required).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '这版保留');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(host.textContent).toContain('未能保存');
    expect(input.value).toBe('这版保留');
    await act(async () =>
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(mutations).toHaveLength(2);
    expect(mutations[0]).toEqual(mutations[1]);
    expect(mutations[0]).toMatchObject({
      reference: record.reference,
      indexedVersionRef: item.record.indexedVersionRef,
      updateFingerprint: update.updateFingerprint,
      reason: '这版保留',
    });
    expect(saved).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
it('a read-only visitor sees the original label and history without writer controls', async () => {
  fetcher.mockResolvedValue(new Response(JSON.stringify({ ...item, canWrite: false, uses: [] })));
  const host = document.createElement('div'),
    root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <AssetCanonDetail
          item={{ ...item, canWrite: false }}
          record={record}
          threadId="film"
          candidates={[item]}
          onSaved={vi.fn()}
          onNextVersion={vi.fn()}
        />,
      ),
    );
    expect(host.textContent).toContain('还没标');
    expect(host.querySelector('[aria-label="素材标记"]')).toBeNull();
    expect(host.textContent).toContain('看取代经过');
  } finally {
    await act(async () => root.unmount());
  }
});
