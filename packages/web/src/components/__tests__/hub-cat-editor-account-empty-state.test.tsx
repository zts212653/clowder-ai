import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));

vi.mock('@/components/useConfirm', () => ({
  useConfirm: () => vi.fn(() => Promise.resolve(true)),
}));

import { HubCatEditor } from '@/components/HubCatEditor';
import type { ProfileItem } from '@/components/hub-accounts.types';

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function profileItem(
  input: Omit<ProfileItem, 'kind' | 'builtin'> & Partial<Pick<ProfileItem, 'kind' | 'builtin'>>,
): ProfileItem {
  const builtin = input.builtin === undefined ? input.authType === 'oauth' : input.builtin;
  const kind = input.kind === undefined ? (builtin ? 'builtin' : 'api_key') : input.kind;
  return { ...input, builtin, kind };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function changeField(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  eventType: 'input' | 'change' = 'input',
) {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event(eventType, { bubbles: true }));
  });
}

function queryField<T extends HTMLElement>(selector: string): T {
  const element = document.body.querySelector(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element as T;
}

describe('HubCatEditor zero-account onboarding', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('offers the Anthropic account flow when CatAgent has no account', async () => {
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (path === '/api/accounts' && method === 'GET') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: null,
            providers: [],
          }),
        );
      }
      if (path === '/api/cat-templates' && method === 'GET') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch request: ${path}:${method}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved: vi.fn() }));
    });
    await flushEffects();

    await changeField(queryField<HTMLSelectElement>('select[aria-label="Client"]'), 'catagent', 'change');
    await flushEffects();

    expect(document.body.textContent).toContain('当前没有可用的认证账号');
    const createAccountButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '新建 / 登录账号',
    );
    expect(createAccountButton).toBeTruthy();

    await act(async () => {
      createAccountButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const authDetails = queryField<HTMLElement>('[data-guide-id="accounts.create-details"]');
    expect(authDetails.textContent).toContain('Claude');
  });

  it('creates authentication from the empty state and continues saving the member', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    let accountCreated = false;
    const createdProfile = profileItem({
      id: 'claude-oauth',
      provider: 'claude-oauth',
      displayName: 'Claude Login',
      name: 'Claude Login',
      authType: 'oauth',
      mode: 'subscription',
      models: ['claude-sonnet-4-6'],
      hasApiKey: false,
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
    });
    const responses = new Map<string, () => Promise<Response>>([
      [
        '/api/accounts:POST',
        () => {
          accountCreated = true;
          return Promise.resolve(jsonResponse({ profile: { id: createdProfile.id } }, 201));
        },
      ],
      [
        '/api/accounts:GET',
        () =>
          Promise.resolve(
            jsonResponse({
              projectPath: '/tmp/project',
              activeProfileId: accountCreated ? createdProfile.id : null,
              providers: accountCreated ? [createdProfile] : [],
            }),
          ),
      ],
      ['/api/cats:POST', () => Promise.resolve(jsonResponse({ cat: { id: 'first-partner' } }, 201))],
      ['/api/cat-templates:GET', () => Promise.resolve(jsonResponse({ templates: [] }))],
    ]);
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      const key = `${path}:${init?.method === undefined ? 'GET' : init.method}`;
      const response = responses.get(key);
      if (!response) throw new Error(`Unexpected apiFetch request: ${key}`);
      return response();
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    expect(document.body.textContent).toContain('当前没有可用的认证账号');
    expect(document.body.textContent).toContain('首次安装默认只启用一个品种');
    expect(queryField<HTMLSelectElement>('select[aria-label="认证信息"]').disabled).toBe(true);

    const createAccountButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '新建 / 登录账号',
    );
    expect(createAccountButton).toBeTruthy();
    await act(async () => {
      createAccountButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await changeField(queryField('input[placeholder="例如: my-claude-account"]'), 'Claude Login');
    const authSaveButton = queryField<HTMLButtonElement>('button[data-guide-id="accounts.create-submit"]');
    await act(async () => {
      authSaveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    await flushEffects();

    expect(document.body.textContent).toContain('添加成员');
    expect(document.body.textContent).not.toContain('添加账户认证');
    const accountSelect = queryField<HTMLSelectElement>('select[aria-label="认证信息"]');
    expect(accountSelect.value).toBe('claude-oauth');
    expect(queryField<HTMLInputElement>('input[aria-label="Model"]').value).toBe('claude-sonnet-4-6');

    await changeField(queryField('input[aria-label="Name"]'), '第一只伙伴猫');
    await changeField(queryField('input[aria-label="Description"]'), '陪我一起完成任务');
    await changeField(queryField('textarea[aria-label="Aliases"]'), '@first-partner');

    const memberSaveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      memberSaveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const postCall = mockApiFetch.mock.calls.find(([path]) => path === '/api/cats');
    expect(postCall).toBeTruthy();
    const payload = JSON.parse(String(postCall?.[1]?.body));
    expect(payload.accountRef).toBe('claude-oauth');
    expect(payload.defaultModel).toBe('claude-sonnet-4-6');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
