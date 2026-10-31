import type { AssetCanonItem, CharacterAssetBinding } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { AssetCanonDetail } from '../AssetCanonDetail';
import { AssetCanonPanel } from '../AssetCanonPanel';
import { item, record, update } from './asset-canon.fixtures';

const { fetcher } = vi.hoisted(() => ({ fetcher: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: '', apiFetch: fetcher }));
vi.mock('@/hooks/useCatData', () => ({ getCachedCats: () => [] }));
const member: CharacterAssetBinding = {
  bindingRef: 'binding:avatar',
  bindingRevision: 7,
  ownerUserId: 'owner',
  indexedVersionRef: item.record.indexedVersionRef,
  slot: { role: 'member-avatar', catId: 'director' },
  actor: { kind: 'human', actorId: 'owner' },
  reason: '原选择',
  evidenceRefs: ['source'],
  recordedAt: '2026-10-26T00:00:00.000Z',
};
const portrait: CharacterAssetBinding = {
  ...member,
  bindingRef: 'binding:portrait',
  bindingRevision: 4,
  slot: {
    subjectRef: { kind: 'member', catId: 'director' },
    representation: 'cat',
    styleKey: 'family',
    role: 'portrait',
  },
};
const bound: AssetCanonItem = {
  ...item,
  record: { ...item.record, status: 'canonical', revision: 8 },
  bindings: [member, portrait],
};
const next: AssetCanonItem = {
  ...item,
  record: {
    ...item.record,
    indexedVersionRef: `asset:sha256:${'e'.repeat(64)}`,
    status: 'canonical',
    revision: 3,
    applicability: [
      { subjectRef: { kind: 'member', catId: 'director' }, representation: 'cat', styleKey: 'family', role: 'avatar' },
      portrait.slot as Extract<typeof portrait.slot, { subjectRef: unknown }>,
    ],
  },
  bindings: [],
};
const mutations: Record<string, unknown>[] = [];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mutations.length = 0;
  fetcher.mockReset().mockImplementation(async (_url, init) => {
    const command = JSON.parse(init.body).command;
    if (command.action === 'read-asset')
      return new Response(
        JSON.stringify({ ...(command.indexedVersionRef === bound.record.indexedVersionRef ? bound : next), uses: [] }),
      );
    mutations.push(command);
    return new Response('{}');
  });
});
function button(host: HTMLElement, text: string) {
  const b = [...host.querySelectorAll('button')].find((b) => b.textContent === text);
  expect(b, `button ${text}`).toBeDefined();
  return b!;
}
async function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
it('corrects an experimental/failed judgment without requiring an unrelated keep decision', async () => {
  const host = document.createElement('div'),
    root = createRoot(host);
  const failed = { ...item, record: { ...item.record, status: 'failed' as const, revision: 1 } };
  fetcher.mockImplementation(async (_url, init) => {
    const c = JSON.parse(init.body).command;
    if (c.action === 'read-asset') return new Response(JSON.stringify({ ...failed, uses: [] }));
    mutations.push(c);
    return new Response('{}');
  });
  try {
    await act(async () =>
      root.render(
        <AssetCanonPanel
          item={failed}
          updates={[{ ...update, kind: 'no_longer_canonical', replacement: undefined }]}
          record={record}
          threadId="film"
          candidates={[failed]}
          onSaved={vi.fn()}
          onNextVersion={vi.fn()}
        />,
      ),
    );
    await act(async () => button(host, '素材详情与标记').click());
    await act(async () => button(host, '正典').click());
    await change(host.querySelector('textarea')!, '核对原件后纠正');
    await act(async () =>
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({ action: 'set-asset-status', status: 'canonical', expectedRevision: 1 });
  } finally {
    await act(async () => root.unmount());
  }
});
it('supersedes a bound original only after loading and explicitly disposing every current binding', async () => {
  const host = document.createElement('div'),
    root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <AssetCanonDetail
          item={next}
          record={record}
          threadId="film"
          candidates={[next, { ...bound, bindings: [], record: { ...bound.record, revision: 0 } }]}
          onSaved={vi.fn()}
          onNextVersion={vi.fn()}
        />,
      ),
    );
    await act(async () => button(host, '取代旧的一件…').click());
    await change(host.querySelector('select[aria-label="被取代的旧件"]')!, bound.record.indexedVersionRef);
    const bindings = [...host.querySelectorAll<HTMLSelectElement>('select[data-binding-ref]')];
    expect(bindings).toHaveLength(2);
    expect(button(host, '记下取代').disabled).toBe(true);
    await change(bindings[0]!, next.record.indexedVersionRef);
    await change(bindings[1]!, 'clear');
    await change(host.querySelector('input')!, '明确处理两个用途');
    await act(async () =>
      host
        .querySelector('form[aria-label="取代旧素材"]')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(mutations[0]).toMatchObject({
      action: 'supersede-asset',
      expectedFromRevision: 8,
      expectedToRevision: 3,
      bindings: [
        {
          bindingRef: member.bindingRef,
          expectedBindingRevision: 7,
          indexedVersionRef: next.record.indexedVersionRef,
          expectedAssetRevision: 3,
          reason: '明确处理两个用途',
        },
        {
          bindingRef: portrait.bindingRef,
          expectedBindingRevision: 4,
          indexedVersionRef: null,
          reason: '明确处理两个用途',
        },
      ],
    });
  } finally {
    await act(async () => root.unmount());
  }
});
it('demoting a bound canonical material requires explicit choices for every use', async () => {
  const host = document.createElement('div'),
    root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <AssetCanonDetail
          item={bound}
          record={record}
          threadId="film"
          candidates={[bound]}
          onSaved={vi.fn()}
          onNextVersion={vi.fn()}
        />,
      ),
    );
    await act(async () => button(host, '失败样本').click());
    const bindings = [...host.querySelectorAll<HTMLSelectElement>('select[data-binding-ref]')];
    expect(bindings).toHaveLength(2);
    await change(host.querySelector('textarea')!, '核对后解除用途');
    await change(bindings[0]!, 'clear');
    expect(button(host, '记下').disabled).toBe(true);
    await change(bindings[1]!, 'clear');
    await act(async () =>
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(mutations[0]).toMatchObject({
      action: 'set-asset-status',
      status: 'failed',
      bindings: [
        { bindingRef: member.bindingRef, indexedVersionRef: null },
        { bindingRef: portrait.bindingRef, indexedVersionRef: null },
      ],
    });
  } finally {
    await act(async () => root.unmount());
  }
});
