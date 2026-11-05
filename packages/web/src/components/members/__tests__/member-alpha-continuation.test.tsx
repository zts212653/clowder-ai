import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { HubCatEditor } from '../../HubCatEditor';
import { initialState } from '../../hub-cat-editor.model';
import { requiredHubCatFields } from '../../hub-cat-editor-required';
import { writeShellLanguage } from '../../shell/shell-language';
import { MemberCopyProvider } from '../editor-presentation';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('../../useConfirm', () => ({ useConfirm: () => vi.fn(async () => true) }));
const cat: CatData = {
  id: 'alpha-fixture',
  name: 'Test member',
  displayName: 'Test member',
  nickname: 'Tester',
  avatar: '/avatars/family/codex61-sol.png',
  color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
  mentionPatterns: ['@tester'],
  carrier: 'cli',
  clientId: 'anthropic',
  accountRef: 'claude',
  defaultModel: 'test-model',
  roleDescription: 'Review partner',
  personality: '',
};
const profile = {
  id: 'claude',
  name: 'Claude',
  displayName: 'Claude',
  clientId: 'anthropic',
  authType: 'oauth',
  kind: 'builtin',
  builtin: true,
  models: [],
};
let root: Root;
let container: HTMLDivElement;
let accounts: (typeof profile)[];
let strategy: 'handoff' | 'compress' | 'hybrid';
let status: 'active' | 'degraded' | 'unavailable';
const json = (body: unknown) => new Response(JSON.stringify(body));
function entry() {
  return {
    catId: cat.id,
    source: 'override',
    hasOverride: true,
    revision: 'fixture-revision',
    changedAt: 1,
    effective: { strategy, thresholds: { warn: 0.8, action: 0.9 }, hybrid: { maxCompressions: 2 } },
    executionStatus: { status, missingCapabilities: status === 'active' ? [] : ['compression_signal'] },
  };
}
beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  writeShellLanguage('en');
  accounts = [profile];
  strategy = 'compress';
  status = 'active';
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (url === '/api/accounts') return json({ providers: accounts });
    if (url === '/api/config/session-strategy') return json({ cats: [entry()] });
    if (url === `/api/config/session-strategy/${cat.id}` && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      strategy = body.strategy;
      status = strategy === 'hybrid' ? 'degraded' : 'active';
      return json({});
    }
    return json({});
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  writeShellLanguage('zh');
  vi.clearAllMocks();
});
async function render(member?: CatData) {
  const onSaved = vi.fn();
  await act(async () =>
    root.render(
      <MemberCopyProvider>
        <HubCatEditor open presentation="page" cat={member} onClose={vi.fn()} onSaved={onSaved} />
      </MemberCopyProvider>,
    ),
  );
  return onSaved;
}
async function click(text: string) {
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
  expect(button, text).toBeTruthy();
  await act(async () => button?.click());
}
async function change(label: string, value: string) {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    `[aria-label="${label}"]`,
  );
  expect(field, label).toBeTruthy();
  if (!field) throw Error(`missing ${label}`);
  const prototype =
    field instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
async function completeIdentity() {
  await change('Name', 'New member');
  await change('Description', 'New role');
  await change('Aliases', '@new-member');
}
function writes() {
  return vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method);
}
const contextText = () => container.querySelector('#member-context')?.textContent ?? '';
const statusText = () =>
  container.querySelector('#member-context section > div:last-child > p:last-child')?.textContent ?? '';
async function changeStrategy(value: string) {
  const label = container.querySelector('#member-context select')?.getAttribute('aria-label');
  if (!label) throw Error('strategy select missing');
  await change(label, value);
}

it.each([
  'anthropic',
  'openai',
  'google',
  'kimi',
  'opencode',
  'catagent',
  'acp',
] as const)('requires a selected account for page creation with %s', (clientId) => {
  const form = {
    ...initialState(null, null),
    configurationSource: 'managed_account' as const,
    clientId,
    name: 'Member',
    roleDescription: 'Role',
    mentionPatterns: '@member',
  };
  expect(requiredHubCatFields(form, null, true).errors.Account).toBe(true);
  expect(requiredHubCatFields(form, null, false).errorMessages).not.toContain('账号');
});
it.each(['zh', 'en'] as const)('keeps the %s account requirement visible and blocks the POST', async (language) => {
  writeShellLanguage(language);
  await render();
  await completeIdentity();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(language === 'zh' ? '账号' : 'Account');
  await click(language === 'zh' ? '添加' : 'Add');
  const account = container.querySelector<HTMLSelectElement>('select[aria-label="Account"]');
  expect(account?.getAttribute('aria-invalid')).toBe('true');
  expect(document.activeElement).toBe(account);
  expect(writes()).toHaveLength(0);
  await change('Account', 'claude');
  expect(account?.getAttribute('aria-invalid')).not.toBe('true');
  await click(language === 'zh' ? '添加' : 'Add');
  expect(writes()).toHaveLength(1);
  expect(writes()[0][0]).toBe('/api/cats');
  expect(JSON.parse(String(writes()[0][1]?.body)).accountRef).toBe('claude');
});
it('retains no-account empty state without an automatic account or a write', async () => {
  accounts = [];
  await render();
  await completeIdentity();
  const add = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Add');
  expect(add?.disabled).toBe(true);
  expect(writes()).toHaveLength(0);
});
it('requires a model after selecting an API key account, then saves the explicit model', async () => {
  accounts = [{ ...profile, authType: 'api_key', kind: 'api_key', builtin: false }];
  await render();
  await completeIdentity();
  await change('Account', 'claude');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Model');
  await click('Add');
  expect(writes()).toHaveLength(0);
  expect(container.querySelector('[aria-label="Model"]')?.getAttribute('aria-invalid')).toBe('true');
  await change('Model', 'explicit-model');
  await click('Add');
  const payload = JSON.parse(String(writes()[0][1]?.body));
  expect(payload.accountRef).toBe('claude');
  expect(payload.defaultModel).toBe('explicit-model');
});
it('keeps Antigravity account-free while preserving the classic check', () => {
  const form = {
    ...initialState(null, null),
    clientId: 'antigravity' as const,
    name: 'Member',
    roleDescription: 'Role',
    mentionPatterns: '@member',
  };
  expect(requiredHubCatFields(form, null, true).errorMessages).toEqual([]);
  expect(requiredHubCatFields({ ...form, clientId: 'anthropic' }, null, false).errorMessages).toEqual([]);
});
it.each(['handoff', 'compress', 'hybrid'] as const)('%s has a warning line first', async (value) => {
  strategy = value;
  await render(cat);
  const ranges = [...container.querySelectorAll('#member-context input[type="range"]')];
  expect(ranges[0]?.getAttribute('aria-label')).toBe('提醒线');
  expect(ranges[1]?.getAttribute('aria-label')).toBe(value === 'compress' ? '记录线' : '交接线');
});
it.each([
  'active',
  'degraded',
  'unavailable',
] as const)('qualifies the saved strategy execution status %s', async (value) => {
  status = value;
  await render(cat);
  const line = statusText();
  expect(line).toContain('Compress in place');
  expect(line).toContain(value === 'active' ? 'Available' : value === 'degraded' ? 'Will not run' : 'Unavailable');
});
it('does not borrow active from the saved strategy for a draft; discard restores it', async () => {
  await render(cat);
  await changeStrategy('hybrid');
  expect(contextText()).toContain('This strategy has not been saved');
  expect(statusText()).not.toContain('Available');
  expect(writes()).toHaveLength(0);
  await click('Discard changes');
  expect(statusText()).toContain('Available');
  expect(container.querySelector<HTMLSelectElement>('#member-context select')?.value).toBe('compress');
});
it('uses the newly read hybrid status after a save without carrying the old active status', async () => {
  const onSaved = await render(cat);
  await changeStrategy('hybrid');
  await click('Save');
  expect(onSaved).toHaveBeenCalledOnce();
  expect(writes().map(([url]) => url)).toEqual([`/api/config/session-strategy/${cat.id}`, `/api/cats/${cat.id}`]);
  await act(async () => root.render(<></>));
  await render(cat);
  const line = statusText();
  expect(line).toContain('Compress, then hand off');
  expect(line).toContain('Will not run');
  expect(line).not.toContain('Available');
  expect(contextText()).not.toContain('This strategy has not been saved');
});
