import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryDeliveryUsage } from '../MemoryDeliveryUsage';

const { apiFetch, catData } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  catData: { cats: [] as { id: string; nickname?: string; displayName: string }[] },
}));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => catData }));
let host: HTMLDivElement;
let root: Root;
const usage = {
  sourceAnchor: 'person-memory:person_usage',
  revision: 'revision-a',
  currentVersion: { read: 7, directRead: 5, cueDrill: 2 },
  allVersions: { read: 10, directRead: 8, cueDrill: 2 },
  recordedUnattributed: {
    currentVersion: { read: 0, directRead: 0, cueDrill: 0 },
    allVersions: { read: 0, directRead: 0, cueDrill: 0 },
  },
  historyComplete: false,
  unverifiedReadCount: null,
  directReadRecordedSince: 1794300000000,
  recent: [],
};
beforeEach(() => {
  catData.cats = [];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  apiFetch.mockImplementation(async (path: string) => ({
    ok: true,
    json: async () =>
      path.includes('/usage?')
        ? { ...usage, sourceAnchor: path.includes('/events/') ? 'event-memory:fixture' : usage.sourceAnchor }
        : { counts: { presented: 1, drilled: 1, applied: 0, dismissed: 0 } },
  }));
});

it('keeps read counts visible without a raw cat ID until the cat name arrives', async () => {
  const catId = 'synthetic-reader';
  apiFetch.mockImplementation(async (path: string) => ({
    ok: true,
    json: async () =>
      path.includes('/usage?')
        ? {
            ...usage,
            recent: [
              {
                eventId: 'read_display_1',
                catId,
                kind: 'direct_read',
                occurredAt: 1794300000000,
                threadId: null,
                sourceRevision: 'revision-a',
              },
            ],
          }
        : { counts: { presented: 1, drilled: 1, applied: 0, dismissed: 0 } },
  }));
  const view = () => (
    <MemoryDeliveryUsage
      family="person_entity"
      anchor="person-memory:person_usage"
      usageEndpoint="/api/memory/people/person_usage/usage?revision=revision-a"
    />
  );
  await act(async () => root.render(view()));
  expect(host.textContent).toContain('被猫翻到 7 次');
  expect(host.textContent).toContain('主动读取');
  expect(host.textContent).not.toContain(catId);
  catData.cats = [{ id: catId, nickname: '验收猫', displayName: '合成验收猫' }];
  await act(async () => root.render(view()));
  expect(host.textContent).toContain('验收猫');
  expect(host.textContent).not.toContain(catId);
  expect(host.textContent).toContain('被猫翻到 7 次');
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
it('shows current native reads, separates older versions and keeps the uncounted history unknown', async () => {
  await act(async () =>
    root.render(
      <MemoryDeliveryUsage
        family="person_entity"
        anchor="person-memory:person_usage"
        usageEndpoint="/api/memory/people/person_usage/usage?revision=revision-a"
      />,
    ),
  );
  expect(host.textContent).toContain('被猫翻到 7 次');
  expect(host.textContent).toContain('之前版本');
  expect(host.textContent).toContain('未计入次数未知');
  expect(host.textContent).not.toContain('从没被想起');
});
it('a stale or unavailable usage read never becomes zero or retains the old version count', async () => {
  await act(async () =>
    root.render(
      <MemoryDeliveryUsage
        family="event"
        anchor="event-memory:fixture"
        usageEndpoint="/api/memory/events/fixture/usage?revision=revision-a"
      />,
    ),
  );
  expect(host.textContent).toContain('被猫翻到 7 次');
  apiFetch.mockImplementation(async () => ({ ok: false }));
  await act(async () =>
    root.render(
      <MemoryDeliveryUsage
        family="event"
        anchor="event-memory:fixture"
        usageEndpoint="/api/memory/events/fixture/usage?revision=revision-b"
      />,
    ),
  );
  expect(host.textContent).toContain('次数暂时读不到');
  expect(host.textContent).not.toContain('被猫翻到 7 次');
  expect(host.textContent).not.toContain('被猫翻到 0 次');
});

it('unbound recorded reads are not presented as verified or as a channel without records', async () => {
  apiFetch.mockImplementation(async (path: string) => ({
    ok: true,
    json: async () =>
      path.includes('/usage?')
        ? {
            ...usage,
            currentVersion: { read: 0, directRead: 0, cueDrill: 0 },
            allVersions: { read: 0, directRead: 0, cueDrill: 0 },
            recordedUnattributed: {
              currentVersion: { read: 1, directRead: 0, cueDrill: 1 },
              allVersions: { read: 2, directRead: 0, cueDrill: 2 },
            },
          }
        : { counts: { presented: 0, drilled: 0, applied: 0, dismissed: 0 } },
  }));
  await act(async () =>
    root.render(
      <MemoryDeliveryUsage
        family="person_entity"
        anchor="person-memory:person_usage"
        usageEndpoint="/api/memory/people/person_usage/usage?revision=revision-a"
      />,
    ),
  );
  expect(host.textContent).toContain('消费猫无法核实');
  expect(host.textContent).toContain('当前版本的读取记录');
  expect(host.textContent).not.toContain('当前版本 · 已核实');
  expect(host.textContent).toContain('当前版本有 1 次');
  expect(host.textContent).toContain('未计入已核实次数');
  expect(host.textContent).toContain('未计入次数未知');
  expect(host.textContent).not.toContain('被猫翻到 1 次');
  expect(host.textContent).not.toContain('点名记忆点开：这条渠道没有记录');
});
