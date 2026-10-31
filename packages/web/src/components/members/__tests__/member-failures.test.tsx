import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import type { ConfigData } from '../../config-viewer-types';
import { MemberListHost } from '../MemberListHost';
import { MemberListPage } from '../MemberListPage';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('../../routing-context/useRoutingContext', () => ({
  useRoutingContext: () => ({ data: null, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock('../MemberTable', () => ({ MemberTable: () => null }));
vi.mock('../../settings/OpenTeamWorkspaceButton', () => ({
  OpenTeamWorkspaceButton: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));
const cats = ['a', 'b'].map(
  (id) => ({ id, displayName: id, defaultModel: 'model', roster: { available: true } }) as CatData,
);
const config: ConfigData = {
  cats: {},
  perCatCapacities: {},
  a2a: { enabled: true, maxDepth: 3 },
  memory: { enabled: true, maxKeysPerThread: 0 },
  governance: { degradationEnabled: true, doneTimeoutMs: 0, heartbeatIntervalMs: 0 },
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});
it('shows a failed config read with an actual retry instead of a concurrent loading message', async () => {
  const onRetryConfig = vi.fn();
  await act(async () =>
    root.render(
      <MemberListHost
        hidden={false}
        config={null}
        configError="配置加载失败 (503)"
        onRetryConfig={onRetryConfig}
        registryLoading={false}
        registryKnown
        onRetryRegistry={vi.fn()}
        cats={cats}
        onAdd={vi.fn()}
        onEdit={vi.fn()}
        onEditCoCreator={vi.fn()}
        onToggle={vi.fn()}
        togglingCatId={null}
      />,
    ),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('读取失败');
  expect(container.textContent).not.toContain('正在读取');
  await act(async () =>
    Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === '重试')
      ?.click(),
  );
  expect(onRetryConfig).toHaveBeenCalledOnce();
});
async function rejectDefaultSave() {
  let attempts = 0;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'PUT') {
      attempts++;
      return new Response(JSON.stringify(attempts === 1 ? { error: 'rejected' } : {}), {
        status: attempts === 1 ? 503 : 200,
      });
    }
    return new Response(JSON.stringify(url === '/api/config/default-cat' ? { catId: 'a' } : { providers: [] }));
  });
  await act(async () =>
    root.render(
      <MemberListPage
        config={config}
        cats={cats}
        onAddMember={vi.fn()}
        onEditMember={vi.fn()}
        onEditCoCreator={vi.fn()}
        onToggleAvailability={vi.fn()}
        togglingCatId={null}
      />,
    ),
  );
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="默认猫"]');
  expect(select).toBeTruthy();
  await act(async () => {
    if (select) select.value = 'b';
    select?.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.textContent).toContain('默认猫保存失败');
  expect(select?.value).toBe('a');
  return select;
}
it('keeps a known default editable after a failed save', async () => {
  const select = await rejectDefaultSave();
  expect(select?.disabled).toBe(false);
});
it('retries the failed default PUT rather than just re-reading the previous choice', async () => {
  const select = await rejectDefaultSave();
  await act(async () =>
    Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === '重试')
      ?.click(),
  );
  const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PUT');
  expect(writes).toHaveLength(2);
  expect(writes.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{ catId: 'b' }, { catId: 'b' }]);
  expect(select?.value).toBe('b');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('offers one-click native detection when the roster is empty', async () => {
  const onAddMember = vi.fn();
  const onDetectMembers = vi.fn();
  await act(async () =>
    root.render(
      <MemberListPage
        config={config}
        cats={[]}
        onAddMember={onAddMember}
        onDetectMembers={onDetectMembers}
        onEditMember={vi.fn()}
        onEditCoCreator={vi.fn()}
        onToggleAvailability={vi.fn()}
        togglingCatId={null}
      />,
    ),
  );
  const button = container.querySelector<HTMLButtonElement>('[data-testid="member-detect-empty-roster"]');
  expect(button?.textContent).toContain('一键检测并添加伙伴');
  await act(async () => button?.click());
  expect(onDetectMembers).toHaveBeenCalledOnce();
  expect(onAddMember).not.toHaveBeenCalled();
});

it('keeps the empty-roster detection entry hidden once a member exists', async () => {
  await act(async () =>
    root.render(
      <MemberListPage
        config={config}
        cats={cats}
        onAddMember={vi.fn()}
        onEditMember={vi.fn()}
        onEditCoCreator={vi.fn()}
        onToggleAvailability={vi.fn()}
        togglingCatId={null}
      />,
    ),
  );
  expect(container.querySelector('[data-testid="member-detect-empty-roster"]')).toBeNull();
  expect(container.querySelector('[data-testid="member-add"]')?.textContent).toContain('添加成员');
});
