import type { ProfileMemoryProposalView } from '@cat-cafe/shared';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryCapsuleDetail } from '../MemoryCapsule';
import { MemoryProfile } from '../MemoryProfile';
import { ProfileDetail } from '../MemoryProfileDetail';
import type { ProfileMemoryRead } from '../owner-memory-read';

const { apiFetch, push } = vi.hoisted(() => ({ apiFetch: vi.fn(), push: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => ({ nickname: '示例猫' }) }) }));
const emptyRevision = `sha256:${'a'.repeat(64)}`;
const revision = `sha256:${'b'.repeat(64)}`;
const capsule = (content: string) => ({
  id: 'capsule',
  type: 'profile' as const,
  layer: 'capsule' as const,
  relationshipKey: null,
  uri: 'cat-cafe-profile://capsule/current',
  title: '关于你',
  status: 'active' as const,
  revision,
  content,
  proposals: [] as ProfileMemoryProposalView[],
});
const proposal = {
  proposalId: 'draft',
  status: 'pending',
  expectedRevision: emptyRevision,
  suggestedContent: '示例用户希望先看图。',
  rationale: '来自刚才的对话。',
  sourceCatId: 'sonnet',
  sourceThreadId: 'draft-thread',
  createdAt: 10,
  decisionEndpointBase: '/api/profile-updates',
  approvalState: 'anchored',
  approvalCardRef: { threadId: 'draft-thread', messageId: 'draft-card' },
} satisfies ProfileMemoryProposalView;
let host: HTMLDivElement;
let root: Root;
let current: ReturnType<typeof capsule> | null;
let drafts: (typeof proposal)[];
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
const button = (name: string) => [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === name);
async function click(name: string) {
  const node = button(name);
  expect(node, name).toBeDefined();
  await act(async () => node?.click());
}
async function type(value: string) {
  const field = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="关于你内容"]');
  expect(field).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, value);
    field?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  current = null;
  drafts = [];
  apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const command = JSON.parse(String(init.body));
      current = capsule(command.content);
      return response({ memoryId: 'capsule', action: command.action, outcome: 'applied', revision, status: 'active' });
    }
    if (path.includes('/source?')) return response({ status: 'not_recorded', sources: [] });
    if (path === '/api/memory/profile')
      return response({
        readStatus: 'ready',
        entries: current ? [current] : [],
        ...(!current ? { capsuleSetup: { revision: emptyRevision, proposals: drafts } } : {}),
      });
    return current ? response(current) : response({ error: 'not_available' }, 404);
  });
});
afterEach(async () => {
  try {
    await act(() => root.unmount());
  } finally {
    if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    host.remove();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  }
});
const open = () => act(async () => root.render(<MemoryProfile onReadSummary={() => {}} />));

it('keeps the empty opening brief discoverable and creates it through the original owner action', async () => {
  await open();
  await click('关于你');
  expect(host.textContent).toContain('现在还是空的');
  await click('添加关于你');
  await type('叫我示例用户，先给结论。');
  await click('保存');
  const post = apiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(post?.[0]).toBe('/api/memory/profile/capsule/actions');
  expect(JSON.parse(post?.[1].body)).toMatchObject({
    action: 'replace_content',
    expectedRevision: emptyRevision,
    content: '叫我示例用户，先给结论。',
  });
  expect(host.textContent).toContain('已保存');
  expect(host.textContent).toContain('叫我示例用户，先给结论。');
});

it('shows a cat draft as pending without making it effective or sending an approval automatically', async () => {
  drafts = [proposal];
  await open();
  expect(host.textContent).toContain('待你决定');
  await click('关于你');
  expect(host.textContent).toContain('现在还是空的');
  expect(host.textContent).toContain(proposal.suggestedContent);
  expect(button('查看并决定')).toBeDefined();
  expect(apiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('counts Unicode body characters consistently and preserves private metadata when editing', async () => {
  current = capsule('---\nsource: original-coordinate\n---\n旧内容。');
  await open();
  await click('关于你');
  expect(host.textContent).not.toContain('source: original-coordinate');
  await click('编辑');
  await type(`${'猫'.repeat(300)}\n  `);
  expect(host.textContent).toContain('300 / 300');
  expect(button('保存')?.disabled).toBe(false);
  await type('猫'.repeat(301));
  expect(host.textContent).toContain('超出 1 字');
  expect(button('保存')?.disabled).toBe(true);
  await type('新的内容。');
  await click('保存');
  const post = apiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(post?.[1].body).content).toBe('---\nsource: original-coordinate\n---\n新的内容。');
});

it('keeps a failed edit and retries the same request rather than discarding the draft', async () => {
  current = capsule('原内容。');
  const ordinary = apiFetch.getMockImplementation();
  if (!ordinary) throw new Error('Expected fixture reader');
  let failed = false;
  apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST' && !failed) {
      failed = true;
      return response({ error: 'mutation_unavailable' }, 503);
    }
    return ordinary(path, init);
  });
  await open();
  await click('关于你');
  await click('编辑');
  await type('还在的修改。');
  await click('保存');
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('还在的修改。');
  expect(host.textContent).toContain('修改还在');
  await click('重新保存');
  const requests = apiFetch.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([, init]) => JSON.parse(init.body));
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
});

it('shows selected relationship history and downgrades it without erasing the original profile', async () => {
  const content = `---
owner_note: keep-this-metadata
opening:
  asOf: '2026-10-03'
  excerpts:
    - kind: relationship
      text: 一起完成过示例合奏。
      source: {threadId: source-thread, messageId: source-message}
    - kind: model_capability
      model: example-model-v1
      text: 当时的示例模型能够完成校对。
      source: {threadId: source-thread, messageId: model-message}
---
完整关系正文仍需保留。`;
  const entry = {
    ...capsule(content),
    id: 'primer:example-cat',
    layer: 'primer' as const,
    relationshipKey: 'example-cat',
  };
  apiFetch.mockResolvedValue(response(entry));
  await act(async () => root.render(<ProfileDetail entry={entry} close={() => {}} reload={() => {}} />));
  expect(host.textContent).toContain('参考 · 截至 2026-10-03');
  expect(host.textContent).toContain('历史能力判断 · example-model-v1');
  expect(host.textContent).not.toContain('owner_note:');
  await click('改为按需回看');
  const post = apiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(post?.[0]).toBe('/api/memory/profile/primer%3Aexample-cat/actions');
  const command = JSON.parse(post?.[1].body);
  expect(command.action).toBe('replace_content');
  expect(command.expectedRevision).toBe(revision);
  expect(command.content).toContain('owner_note: keep-this-metadata');
  expect(command.content).toContain('完整关系正文仍需保留。');
  expect(command.content).not.toContain('opening:');
});

it.each([
  'capsule',
  'primer',
] as const)('does not use a browser scroll promise as the %s effect cleanup', async (layer) => {
  const scroll = vi.fn(() => Promise.resolve());
  vi.stubGlobal('innerWidth', 390);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
  const entry: ProfileMemoryRead = {
    ...capsule('示例内容。'),
    layer,
    relationshipKey: layer === 'primer' ? 'example-cat' : null,
    id: layer === 'capsule' ? 'capsule' : 'primer:example-cat',
  };
  apiFetch.mockResolvedValue(response(entry));
  await act(async () =>
    root.render(
      <StrictMode>
        {layer === 'capsule' ? (
          <MemoryCapsuleDetail entry={entry} close={() => {}} reload={() => {}} />
        ) : (
          <ProfileDetail entry={entry} close={() => {}} reload={() => {}} />
        )}
      </StrictMode>,
    ),
  );
  await act(async () => root.render(null));
  expect(scroll).toHaveBeenCalled();
});

it.each([
  'replace_content',
  'hard_forget',
] as const)('waits for the new owner entry after %s instead of rereading an obsolete revision', async (operation) => {
  current = capsule('原内容。');
  const initial = current;
  const reload = vi.fn();
  let mutated = false;
  const revisionReadsAfterMutation: string[] = [];
  const nextRevision = `sha256:${'c'.repeat(64)}`;
  apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      mutated = true;
      current = operation === 'hard_forget' ? null : { ...capsule('新版内容。'), revision: nextRevision };
      return response({
        memoryId: 'capsule',
        action: operation,
        outcome: 'applied',
        revision: nextRevision,
        status: 'active',
        ...(operation === 'hard_forget'
          ? {
              forgetScope: {
                canonicalMemory: 'deleted',
                derivedProjections: 'invalidated',
                originalSource: 'preserved',
                immutableAudit: 'retained',
              },
            }
          : {}),
      });
    }
    if (path.includes('/source?')) return response({ status: 'not_recorded', sources: [] });
    if (path === '/api/memory/profile')
      return response({
        readStatus: 'ready',
        entries: current ? [current] : [],
        ...(!current ? { capsuleSetup: { revision: emptyRevision, proposals: [] } } : {}),
      });
    if (mutated) {
      revisionReadsAfterMutation.push(path);
      if (path.includes(encodeURIComponent(revision)))
        return response({ error: 'stale_revision' }, current ? 409 : 404);
    }
    return current ? response(current) : response({}, 404);
  });
  await act(async () => root.render(<MemoryCapsuleDetail entry={initial} close={() => {}} reload={reload} />));
  if (operation === 'replace_content') {
    await click('编辑');
    await type('新版内容。');
    await click('保存');
  } else {
    await click('忘掉关于你');
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
    await click('确认永久遗忘');
  }
  expect(reload).toHaveBeenCalledOnce();
  expect(revisionReadsAfterMutation).toEqual([]);
  // The owner list may return later. The detail must wait for its new authoritative entry.
  await act(async () =>
    root.render(<MemoryCapsuleDetail entry={current ?? undefined} close={() => {}} reload={reload} />),
  );
  expect(host.textContent).toContain(operation === 'hard_forget' ? '现在还是空的' : '新版内容。');
  expect(revisionReadsAfterMutation.every((path) => !path.includes(encodeURIComponent(revision)))).toBe(true);
});

// The accepted page must start with the current brief visible, without an extra card click.
it('opens About you by default and keeps the selected owner content visible', async () => {
  current = capsule('第一句。\n第二句。');
  await open();
  const detail = host.querySelector('aside[aria-label="画像详情"]');
  expect(detail).not.toBeNull();
  expect(detail?.textContent).toContain('第一句。');
  expect(button('关于你')?.getAttribute('aria-pressed')).toBe('true');
});

// Card navigation must not silently throw away an owner edit.
it('keeps an unsaved About you edit until the owner explicitly discards it', async () => {
  current = capsule('原内容。');
  const ordinary = apiFetch.getMockImplementation();
  if (!ordinary) throw new Error('Expected fixture reader');
  const corpus = { ...capsule('共同画像正文。'), id: 'corpus', layer: 'corpus' as const, title: '共同画像' };
  apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/memory/profile') return response({ readStatus: 'ready', entries: [current, corpus] });
    if (path.startsWith('/api/memory/profile/corpus?')) return response(corpus);
    return ordinary(path, init);
  });
  await open();
  await click('编辑');
  await type('暂时没有保存的修改。');
  await click('共同画像');
  expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
  expect(host.querySelector('textarea')?.value).toBe('暂时没有保存的修改。');
  await click('继续编辑');
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  await click('共同画像');
  await click('放弃并切换');
  expect(host.querySelector('aside')?.textContent).toContain('共同画像正文。');
  expect(apiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('does not discard an owner draft or silently rebase it when the original proposal is decided elsewhere', async () => {
  current = { ...capsule('原内容。'), proposals: [proposal] };
  await open();
  await click('编辑');
  await type('未保存的主人修改。');
  apiFetch.mockClear();
  await act(async () =>
    window.dispatchEvent(new CustomEvent('cat-cafe:proposal-updated', { detail: { proposalId: proposal.proposalId } })),
  );
  expect(host.querySelector('textarea')?.value).toBe('未保存的主人修改。');
  expect(apiFetch).not.toHaveBeenCalled();
  await click('放弃修改');
  expect(apiFetch.mock.calls.some(([path]) => path === '/api/memory/profile')).toBe(true);
});
