// @vitest-environment jsdom
import { applyWatcherConfigPatch, parseWatcherConfig } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fetcher = vi.fn();
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => fetcher(...args) }));

import { WatcherSettings } from '../WatcherSettings';

let root: Root, container: HTMLDivElement;
let config = parseWatcherConfig(undefined);
let saveStatus = 200;
const writes: Array<Record<string, unknown>> = [];
const members = [
  {
    catId: 'primary-custom',
    displayName: '主成员',
    capability: { supported: true, context: 'ordinary', readOnly: 'tools' },
    accounts: [{ id: 'primary-own-account', label: '主猫自己的备选账号' }],
  },
  {
    catId: 'alternate-custom',
    displayName: '替换成员',
    capability: { supported: true, context: 'ordinary', readOnly: 'tools' },
    accounts: [{ id: 'alternate-own-account', label: '另一家账号' }],
  },
  { catId: 'other-provider', displayName: '别家的成员', capability: { supported: false, reason: '文件读取尚未接通' } },
];
const snapshot = () => ({
  config,
  members,
  quietLabels: [],
  availableLabels: [],
  panelAccounts: [],
  rolloutEnabled: true,
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  config = parseWatcherConfig(undefined);
  saveStatus = 200;
  writes.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetcher.mockImplementation(async (_path, options) => {
    if (options?.method === 'PUT') {
      const { expectedRevision, ...patch } = JSON.parse(options.body);
      writes.push({ expectedRevision, ...patch });
      if (saveStatus !== 200) return { ok: false, status: saveStatus, json: async () => ({ error: '设置不可用' }) };
      expect(expectedRevision).toBe(config.revision);
      config = applyWatcherConfigPatch(config, patch);
    }
    return { ok: true, status: 200, json: async () => snapshot() };
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  fetcher.mockReset();
});

async function render() {
  await act(async () => {
    root.render(<WatcherSettings />);
  });
}
async function choose(label: string, value: string) {
  const field = container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
  expect(field).not.toBeNull();
  await act(async () => {
    field.value = value;
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

it('has one off switch and two global choices, without the old bounded or comparison entry', async () => {
  await render();
  expect(container.querySelectorAll('[role="switch"]')).toHaveLength(1);
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
  expect(container.querySelector('[aria-label="主守望猫"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="同家时由谁看"]')).not.toBeNull();
  expect(container.textContent).not.toContain('多只守望');
  expect(container.querySelector('[aria-label="守望哪些对话"]')).toBeNull();
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  expect(container.querySelector('option[value="other-provider"]')?.textContent).toContain('还没接通');
});

it('persists arbitrary member selection while staying off, then enables only ordinary-context routing', async () => {
  await render();
  await choose('主守望猫', 'primary-custom');
  expect(config.enabled).toBe(false);
  expect(config.routing?.primary.catId).toBe('primary-custom');
  expect(config.scope).toBe('all');
  await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(config.enabled).toBe(true);
  expect(writes.at(-1)?.routing).toEqual({
    primary: { catId: 'primary-custom' },
    whenSameFamily: { mode: 'primary' },
    maxConcurrentRuns: 6,
  });
});

it('saves all three same-family choices and keeps the primary when an alternate is selected', async () => {
  await render();
  await choose('主守望猫', 'primary-custom');
  await choose('同家时由谁看', 'skip');
  expect(config.routing?.whenSameFamily).toEqual({ mode: 'skip' });
  await choose('同家时由谁看', 'member:alternate-custom');
  expect(config.routing?.whenSameFamily).toEqual({ mode: 'member', member: { catId: 'alternate-custom' } });
  expect(config.routing?.primary.catId).toBe('primary-custom');
  await choose('同家时由谁看', 'primary');
  expect(config.routing?.whenSameFamily).toEqual({ mode: 'primary' });
});

it('shows a save conflict and retains the last server-confirmed choice', async () => {
  await render();
  await choose('主守望猫', 'primary-custom');
  saveStatus = 409;
  await choose('同家时由谁看', 'skip');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('设置已改变');
  expect(config.routing?.whenSameFamily).toEqual({ mode: 'primary' });
  expect(container.querySelector<HTMLSelectElement>('[aria-label="同家时由谁看"]')?.value).toBe('primary');
});

it('offers only the selected member’s accounts and clears an override when changing provider', async () => {
  await render();
  await choose('主守望猫', 'primary-custom');
  const options = () =>
    [...container.querySelectorAll<HTMLSelectElement>('[aria-label="主守望猫使用的账号"] option')].map(
      (option) => option.value,
    );
  expect(options()).toEqual(['', 'primary-own-account']);
  await choose('主守望猫使用的账号', 'primary-own-account');
  expect(config.routing?.primary.accountRef).toBe('primary-own-account');
  await choose('主守望猫', 'alternate-custom');
  expect(options()).toEqual(['', 'alternate-own-account']);
  expect(config.routing?.primary.accountRef).toBeUndefined();
  expect(config.enabled).toBe(false);
});
