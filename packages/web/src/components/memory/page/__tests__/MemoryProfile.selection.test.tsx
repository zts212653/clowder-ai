import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryCapsuleCard } from '../MemoryCapsule';
import { MemoryProfile } from '../MemoryProfile';
import { MemoryProfileCard } from '../MemoryProfileCard';
import type { ProfileMemoryRead } from '../owner-memory-read';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [{ id: 'astra', relationshipKey: 'astra', nickname: '示例猫', displayName: '示例猫' }],
    hasFetched: true,
  }),
}));
vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: () => <span data-testid="avatar">猫</span>,
}));
const entries: ProfileMemoryRead[] = [
  { id: 'capsule', layer: 'capsule', title: '关于你', content: '开场示例正文。', relationshipKey: null },
  { id: 'corpus', layer: 'corpus', title: '共同画像', content: '共同示例正文。', relationshipKey: null },
  { id: 'primer:astra', layer: 'primer', title: '关系画像', content: '关系示例正文。', relationshipKey: 'astra' },
].map((entry) => ({
  ...entry,
  layer: entry.layer as ProfileMemoryRead['layer'],
  type: 'profile',
  status: 'active',
  revision: `sha256:${'a'.repeat(64)}`,
  uri: 'cat-cafe-profile://example/current',
  proposals: [],
}));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  apiFetch.mockImplementation(async (path: string) => ({
    ok: true,
    json: async () =>
      path === '/api/memory/profile'
        ? { readStatus: 'ready', entries }
        : path.includes('/source?')
          ? { status: 'not_recorded', sources: [] }
          : entries.find((entry) => path.includes(`/profile/${encodeURIComponent(entry.id)}?`)),
  }));
});
afterEach(async () => {
  window.getSelection()?.removeAllRanges();
  await act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const click = (node: HTMLElement | null) => {
  expect(node).not.toBeNull();
  return act(async () => node?.click());
};
const card = (index: number) => host.querySelectorAll('article')[index];
const title = (index: number) => card(index).querySelector<HTMLButtonElement>('button[aria-pressed]');
const button = (name: string) =>
  [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === name) ?? null;

it.each([
  0, 1, 2,
])('opens entry %i from its body, card padding, badge and avatar, then offers its editor', async (index) => {
  await act(async () => root.render(<MemoryProfile onReadSummary={() => {}} />));
  const zones = ['p.line-clamp-3', ':scope', 'span.rounded, span.rounded-full'];
  if (index === 2) zones.push('[data-testid="avatar"]');
  for (const zone of zones) {
    await click(title(index === 0 ? 1 : 0));
    await click(zone === ':scope' ? card(index) : card(index).querySelector<HTMLElement>(zone));
    expect(title(index)?.getAttribute('aria-pressed'), zone).toBe('true');
    expect(host.querySelector('aside')?.textContent, zone).toContain(entries[index].content);
  }
  await click(button('编辑'));
  expect(host.querySelector('textarea')?.value).toBe(entries[index].content);
  expect(apiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it.each([
  'another card',
  'back',
])('retains a dirty draft when choosing %s until the owner confirms leaving', async (target) => {
  await act(async () => root.render(<MemoryProfile onReadSummary={() => {}} />));
  await click(title(1));
  await click(button('编辑'));
  const field = host.querySelector('textarea');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, '还没保存的修改');
    field?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const leave = () =>
    click(target === 'back' ? button('返回画像') : card(2).querySelector<HTMLElement>('p.line-clamp-3'));
  await leave();
  expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
  expect(host.querySelector('textarea')?.value).toBe('还没保存的修改');
  expect(title(1)?.getAttribute('aria-pressed')).toBe('true');
  await click(button('继续编辑'));
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  expect(host.querySelector('textarea')?.value).toBe('还没保存的修改');
  await leave();
  await click(button('放弃并切换'));
  if (target === 'back') expect(host.querySelector('aside')).toBeNull();
  else expect(host.querySelector('aside')?.textContent).toContain(entries[2].content);
  expect(host.querySelector('textarea')).toBeNull();
  expect(apiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it.each([
  0, 1, 2,
])('keeps text selectable in entry %i and does not double-activate its nested title button', async (index) => {
  const select = vi.fn();
  await act(async () =>
    root.render(
      index === 0 ? (
        <MemoryCapsuleCard entry={entries[index]} selected={false} select={select} />
      ) : (
        <MemoryProfileCard entry={entries[index]} selected={false} select={select} />
      ),
    ),
  );
  const body = host.querySelector<HTMLElement>('p.line-clamp-3');
  if (!body) throw new Error('Card body is missing');
  const range = document.createRange();
  range.selectNodeContents(body);
  window.getSelection()?.addRange(range);
  await click(body);
  expect(select).not.toHaveBeenCalled();
  expect(window.getSelection()?.toString()).toBe(entries[index].content);
  await click(host.querySelector('button'));
  expect(select).toHaveBeenCalledTimes(1);
  window.getSelection()?.removeAllRanges();
  await click(body);
  expect(select).toHaveBeenCalledTimes(2);
});
