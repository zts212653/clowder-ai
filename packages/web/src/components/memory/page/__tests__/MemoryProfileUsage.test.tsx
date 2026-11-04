import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { formatModelName } from '@/lib/model-display-name';
import { MemoryCapsuleCard } from '../MemoryCapsule';
import { MemoryProfileSource } from '../MemoryProfileSource';
import type { ProfileMemoryRead } from '../owner-memory-read';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: [], hasFetched: true }) }));
let host: HTMLDivElement;
let root: Root;
const response = (value: unknown) => ({ ok: true, json: async () => value });
const summary = {
  openingMode: 'enabled',
  memoryId: 'capsule',
  revision: 'rev',
  currentVersion: { opening: 3, read: 0 },
  allVersions: { opening: 7, read: 2 },
  historyComplete: false,
  directReadRecordedSince: 1793268000000,
  earliestRecordedAt: 1793000000000,
  recent: [],
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  apiFetch.mockImplementation(async (path: string) =>
    response(path.includes('/usage?') ? summary : { status: 'not_recorded', sources: [] }),
  );
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
it('shows version-bound counts with an honest history boundary, and never turns a failed read into zero', async () => {
  await act(async () =>
    root.render(<MemoryProfileSource endpoint="/api/memory/profile/capsule/source?revision=rev" opening />),
  );
  expect(host.textContent).toContain('新对话带上 3 次');
  expect(host.textContent).toContain('被猫翻到 0 次');
  expect(host.textContent).toContain('历史未知');
  expect(host.textContent).toContain('之前版本');
  apiFetch.mockImplementation(async (path: string) =>
    path.includes('/usage?') ? { ok: false } : response({ status: 'not_recorded', sources: [] }),
  );
  await act(async () =>
    root.render(<MemoryProfileSource endpoint="/api/memory/profile/capsule/source?revision=new" opening />),
  );
  expect(host.textContent).toContain('次数暂时读不到');
  expect(host.textContent).not.toContain('被猫翻到 0 次');
});
it('uses the approved capsule label and the same Chinese/Latin summary spacing as other profile cards', async () => {
  const entry = {
    id: 'capsule',
    content: '讨论原因。\n我喜欢 GPT 6.1。\nhello\nworld',
    proposals: [],
  } as unknown as ProfileMemoryRead;
  await act(async () => root.render(<MemoryCapsuleCard entry={entry} selected select={() => {}} />));
  expect(host.textContent).toContain('每场新对话自动带上');
  expect(host.textContent).toContain('讨论原因。我喜欢 GPT 6.1。hello world');
});
it('looks up only the exact historical model and never substitutes a member current model', () => {
  const registry = [{ defaultModel: 'gpt-6.1-sol', variantLabel: 'GPT-6.1 Sol' }];
  expect(formatModelName('gpt-6.1-sol', registry)).toBe('GPT-6.1 Sol');
  expect(formatModelName('gpt-5.6-sol', registry)).toBe('GPT 5.6 Sol');
});
