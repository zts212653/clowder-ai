import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryCapsuleDetail } from '../MemoryCapsule';
import { ProfileDetail } from '../MemoryProfileDetail';
import type { ProfileMemoryRead } from '../owner-memory-read';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: [], hasFetched: true }) }));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => null }));
const originalRevision = `sha256:${'b'.repeat(64)}`;
const nextRevision = `sha256:${'c'.repeat(64)}`;
const emptyRevision = `sha256:${'a'.repeat(64)}`;
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
async function click(name: string) {
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === name);
  expect(button, name).toBeDefined();
  await act(async () => button?.click());
}
async function edit(content: string) {
  await click('编辑');
  const field = host.querySelector('textarea');
  expect(field).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, content);
    field?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function fixture(layer: ProfileMemoryRead['layer'], sameRevision = false) {
  const initial: ProfileMemoryRead = {
    id: layer === 'primer' ? 'primer:example' : layer,
    type: 'profile',
    layer,
    relationshipKey: layer === 'primer' ? 'example' : null,
    uri: 'cat-cafe-profile://capsule/current',
    title: '画像',
    status: 'active',
    revision: originalRevision,
    content: '原内容。',
    proposals: [],
  };
  let current: ProfileMemoryRead | null = initial;
  let mutated = false;
  const reload = vi.fn();
  const revisionReadsAfterMutation: string[] = [];
  function apply(body: BodyInit | null | undefined) {
    const command: { action: string; content: string } = JSON.parse(String(body));
    mutated = true;
    current =
      command.action === 'hard_forget'
        ? null
        : {
            ...initial,
            content: command.content,
            revision: sameRevision ? originalRevision : nextRevision,
          };
    return response({
      memoryId: initial.id,
      action: command.action,
      outcome: 'applied',
      ...(current
        ? { revision: current.revision, status: 'active' }
        : {
            forgetScope: {
              canonicalMemory: 'deleted',
              derivedProjections: 'invalidated',
              originalSource: 'preserved',
              immutableAudit: 'retained',
            },
          }),
    });
  }
  function usage(profile: ProfileMemoryRead) {
    return response({
      memoryId: profile.id,
      revision: profile.revision,
      openingMode: layer === 'capsule' ? 'enabled' : 'on_demand',
      currentVersion: { opening: 0, read: mutated ? 7 : 3 },
      allVersions: { opening: 0, read: 10 },
      historyComplete: false,
      directReadRecordedSince: 1793268000000,
      earliestRecordedAt: null,
      recent: [],
    });
  }
  function read(path: string) {
    if (mutated) revisionReadsAfterMutation.push(path);
    if (!current || !path.includes(encodeURIComponent(current.revision)))
      return response({ error: 'stale_revision' }, current ? 409 : 404);
    if (path.includes('/source?')) return response({ status: 'not_recorded', sources: [] });
    if (path.includes('/usage?')) return usage(current);
    return response(current);
  }
  apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') return apply(init.body);
    if (path === '/api/memory/profile')
      return response({
        readStatus: 'ready',
        entries: current ? [current] : [],
        ...(!current ? { capsuleSetup: { revision: emptyRevision, proposals: [] } } : {}),
      });
    return read(path);
  });
  const render = (entry: ProfileMemoryRead | null) =>
    act(async () =>
      root.render(
        layer === 'capsule' ? (
          <MemoryCapsuleDetail entry={entry ?? undefined} close={() => {}} reload={reload} />
        ) : entry ? (
          <ProfileDetail entry={entry} close={() => {}} reload={reload} />
        ) : null,
      ),
    );
  return { initial, reload, revisionReadsAfterMutation, render, latest: () => current };
}

it.each([
  ['capsule', 'replace_content'],
  ['capsule', 'hard_forget'],
  ['corpus', 'replace_content'],
  ['corpus', 'hard_forget'],
  ['primer', 'replace_content'],
  ['primer', 'hard_forget'],
] as const)('waits for the new %s owner entry after %s before reading content, usage or sources', async (layer, action) => {
  const f = fixture(layer);
  await f.render(f.initial);
  expect(host.textContent).toContain('被猫翻到 3 次');
  if (action === 'replace_content') {
    await edit('新版内容。');
    await click('保存');
  } else {
    await click(layer === 'capsule' ? '忘掉关于你' : '忘掉画像');
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
    await click('确认永久遗忘');
  }
  expect(f.reload).toHaveBeenCalledOnce();
  expect(f.revisionReadsAfterMutation).toEqual([]);
  expect(host.textContent).not.toContain('原内容。');
  expect(host.textContent).not.toContain('被猫翻到 3 次');
  expect(host.textContent).toContain('正在读取');
  // A rerender of the same owner revision must not unblock stale child reads.
  await f.render({ ...f.initial });
  expect(f.revisionReadsAfterMutation).toEqual([]);
  await f.render(f.latest());
  if (action === 'replace_content') {
    expect(host.textContent).toContain('新版内容。');
    expect(host.textContent).toContain('被猫翻到 7 次');
    expect(f.revisionReadsAfterMutation.some((path) => path.includes('/usage?'))).toBe(true);
    expect(f.revisionReadsAfterMutation.some((path) => path.includes('/source?'))).toBe(true);
  } else if (layer === 'capsule') expect(host.textContent).toContain('现在还是空的');
  else expect(host.textContent).toBe('');
  expect(f.revisionReadsAfterMutation.every((path) => !path.includes(encodeURIComponent(originalRevision)))).toBe(true);
});

it('keeps a successful unchanged-content save readable instead of waiting for a nonexistent new revision', async () => {
  const f = fixture('corpus', true);
  await f.render(f.initial);
  await click('编辑');
  await click('保存');
  expect(f.reload).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('原内容。');
  expect(host.textContent).not.toContain('正在读取');
});

it('allows the current usage and sources to remount when an edit is discarded without a mutation', async () => {
  const f = fixture('capsule');
  await f.render(f.initial);
  await edit('不保存的内容。');
  await click('放弃修改');
  expect(apiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  expect(host.textContent).toContain('原内容。');
  expect(host.textContent).toContain('被猫翻到 3 次');
  expect(host.textContent).not.toContain('正在读取');
});
