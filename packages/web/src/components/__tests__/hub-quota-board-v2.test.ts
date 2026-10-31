/**
 * F051 v2 — HubQuotaBoardTab tests (glanceable quota board)
 *
 * Tests the rewritten quota board: flat pool list, one refresh button,
 * no ops UI. Each pool is a row with color dot + progress bar + percent.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuotaResponse } from './quota-test-fixtures';

// --- Fixtures ---

const MOCK_CATS = [
  {
    id: 'opus',
    displayName: '布偶猫',
    nickname: '宪宪',
    color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
    mentionPatterns: ['@opus'],
    clientId: 'anthropic',
    accountRef: 'claude-oauth',
    defaultModel: 'claude-opus-4-6',
    avatar: '/avatars/opus.png',
    roleDescription: '架构',
    personality: '稳重',
  },
  {
    id: 'codex',
    displayName: '缅因猫',
    nickname: '砚砚',
    color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
    mentionPatterns: ['@codex'],
    clientId: 'openai',
    accountRef: 'codex-oauth',
    defaultModel: 'gpt-5.4',
    avatar: '/avatars/codex.png',
    roleDescription: 'review',
    personality: 'rigorous',
  },
  {
    id: 'spark',
    displayName: '缅因猫',
    nickname: 'Spark',
    color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
    mentionPatterns: ['@spark'],
    clientId: 'openai',
    accountRef: 'codex-sponsor',
    defaultModel: 'gpt-5.4-mini',
    avatar: '/avatars/spark.png',
    roleDescription: 'fast coding',
    personality: 'sharp',
  },
  {
    id: 'gemini25',
    displayName: '暹罗猫',
    nickname: 'Gemini 2.5',
    color: { primary: '#EAA54B', secondary: '#F8E7C7' },
    mentionPatterns: ['@gemini25'],
    clientId: 'google',
    accountRef: 'gemini-oauth',
    defaultModel: 'gemini-2.5-pro',
    avatar: '/avatars/gemini25.png',
    roleDescription: 'design',
    personality: 'bold',
  },
  {
    id: 'antigravity',
    displayName: '孟加拉猫',
    nickname: '豹猫',
    color: { primary: '#C97A35', secondary: '#F5E4D0' },
    mentionPatterns: ['@antigravity'],
    clientId: 'antigravity',
    defaultModel: 'gemini-3.1-pro',
    avatar: '/avatars/antigravity.png',
    roleDescription: 'bridge',
    personality: 'curious',
  },
];

const MOCK_QUOTA_RESPONSE: QuotaResponse = {
  claude: {
    platform: 'claude',
    activeBlock: null,
    usageItems: [
      { label: 'Current session', usedPercent: 7, poolId: 'claude-session' },
      { label: 'Current week (all models)', usedPercent: 54, poolId: 'claude-weekly-all' },
      { label: 'Current week (Sonnet only)', usedPercent: 3, poolId: 'claude-weekly-sonnet' },
    ],
    recentBlocks: [],
    lastChecked: '2026-03-02T16:45:00Z',
  },
  codex: {
    platform: 'codex',
    usageItems: [
      { label: '5小时使用限额', usedPercent: 100, percentKind: 'remaining', poolId: 'codex-main' },
      { label: '每周使用限额', usedPercent: 80, percentKind: 'remaining', poolId: 'codex-main' },
      { label: 'GPT-5.3-Codex-Spark 5小时使用限额', usedPercent: 100, percentKind: 'remaining', poolId: 'codex-spark' },
      { label: 'GPT-5.3-Codex-Spark 每周使用限额', usedPercent: 93, percentKind: 'remaining', poolId: 'codex-spark' },
      { label: '代码审查', usedPercent: 44, percentKind: 'remaining', poolId: 'codex-review' },
    ],
    lastChecked: '2026-03-02T16:30:00Z',
  },
  gemini: {
    platform: 'gemini',
    usageItems: [
      { label: 'Gemini 2.5 Pro', usedPercent: 90, percentKind: 'remaining', poolId: 'gemini-pro' },
      { label: 'Gemini 2.5 Flash', usedPercent: 60, percentKind: 'remaining', poolId: 'gemini-flash' },
    ],
    lastChecked: '2026-03-02T16:40:00Z',
  },
  antigravity: {
    platform: 'antigravity',
    usageItems: [{ label: 'Codeium', usedPercent: 98, percentKind: 'remaining', poolId: 'codeium-main' }],
    lastChecked: '2026-03-02T16:42:00Z',
  },
  fetchedAt: '2026-03-02T16:45:00Z',
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function defaultQuotaApiFetch(path: string) {
  if (path === '/api/quota') return Promise.resolve(jsonResponse(MOCK_QUOTA_RESPONSE));
  if (path === '/api/accounts') {
    return Promise.resolve(
      jsonResponse({
        projectPath: '/tmp/project',
        activeProfileId: 'claude-oauth',
        activeProfileIds: {
          anthropic: 'claude-oauth',
          openai: 'codex-sponsor',
          google: 'gemini-oauth',
        },
        providers: [
          {
            id: 'claude-oauth',
            provider: 'claude-oauth',
            displayName: 'Claude (OAuth)',
            name: 'Claude (OAuth)',
            authType: 'oauth',
            builtin: true,
            clientId: 'anthropic',
            protocol: 'anthropic',

            mode: 'subscription',
            models: ['claude-opus-4-6'],
            hasApiKey: false,
            createdAt: '2026-03-18T00:00:00.000Z',
            updatedAt: '2026-03-18T00:00:00.000Z',
          },
          {
            id: 'codex-oauth',
            provider: 'codex-oauth',
            displayName: 'Codex (OAuth)',
            name: 'Codex (OAuth)',
            authType: 'oauth',
            builtin: true,
            clientId: 'openai',
            protocol: 'openai',

            mode: 'subscription',
            models: ['gpt-5.4'],
            hasApiKey: false,
            createdAt: '2026-03-18T00:00:00.000Z',
            updatedAt: '2026-03-18T00:00:00.000Z',
          },
          {
            id: 'gemini-oauth',
            provider: 'gemini-oauth',
            displayName: 'Gemini (OAuth)',
            name: 'Gemini (OAuth)',
            authType: 'oauth',
            builtin: true,
            clientId: 'google',
            protocol: 'google',

            mode: 'subscription',
            models: ['gemini-2.5-pro'],
            hasApiKey: false,
            createdAt: '2026-03-18T00:00:00.000Z',
            updatedAt: '2026-03-18T00:00:00.000Z',
          },
          {
            id: 'codex-sponsor',
            provider: 'codex-sponsor',
            displayName: 'Codex Sponsor',
            name: 'Codex Sponsor',
            authType: 'api_key',
            builtin: false,
            protocol: 'openai',

            mode: 'api_key',
            models: ['gpt-5.4-mini'],
            hasApiKey: true,
            createdAt: '2026-03-18T00:00:00.000Z',
            updatedAt: '2026-03-18T00:00:00.000Z',
          },
        ],
      }),
    );
  }
  return Promise.resolve(new Response('{}', { status: 404 }));
}

// --- Mocks ---

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(defaultQuotaApiFetch),
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: MOCK_CATS,
    isLoading: false,
    getCatById: () => undefined,
    getCatsByBreed: () => new Map(),
    refresh: () => Promise.resolve(MOCK_CATS),
  }),
}));

import { HubQuotaBoardTab } from '@/components/HubQuotaBoardTab';
import { apiFetch } from '@/utils/api-client';

const mockApiFetch = vi.mocked(apiFetch);

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('HubQuotaBoardTab v2 — glanceable quota board', () => {
  it('renders the 配额看板 title', () => {
    const html = renderToStaticMarkup(React.createElement(HubQuotaBoardTab));
    expect(html).toContain('配额看板');
  });

  it('renders 刷新全部 button (no confirm dialog)', () => {
    const html = renderToStaticMarkup(React.createElement(HubQuotaBoardTab));
    expect(html).toContain('刷新全部');
  });

  it('renders F127 group headings on static render', () => {
    const html = renderToStaticMarkup(React.createElement(HubQuotaBoardTab));
    expect(html).toContain('OAuth 账号额度（按账号配置）');
    expect(html).toContain('API Key 额度（按账号配置）');
    expect(html).toContain('F127 变化说明');
  });

  it('does NOT contain old ops UI elements', () => {
    const html = renderToStaticMarkup(React.createElement(HubQuotaBoardTab));
    expect(html).not.toContain('Telemetry');
    expect(html).not.toContain('遥测');
    expect(html).not.toContain('状态总览');
    expect(html).not.toContain('操作建议');
    expect(html).not.toContain('止血模式');
    expect(html).not.toContain('探针');
    expect(html).not.toContain('CDP');
    expect(html).not.toContain('打开小组件视图');
  });
});

describe('HubQuotaBoardTab — account pool grouping', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockApiFetch.mockImplementation(defaultQuotaApiFetch);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('keeps a managed account quota separate from the local default and refreshes that exact account', async () => {
    const paths: string[] = [];
    const successfulQuota = {
      owner: { accountRef: 'codex-managed-fixture', userId: 'company-user', workspaceId: 'company-workspace' },
      status: 'ok',
      source: 'codex_official_readonly',
      observedAt: 1772470000000,
      items: [{ label: '公司号额度', usedPercent: 32, percentKind: 'remaining' }],
    };
    let suppliedQuota: typeof successfulQuota & { error?: string } = successfulQuota;
    const managedRef = 'codex-managed-fixture';
    const accountResponse = await (await defaultQuotaApiFetch('/api/accounts')).json();
    const managed = {
      ...accountResponse.providers.find((profile: { clientId?: string }) => profile.clientId === 'openai'),
      id: managedRef,
      displayName: '公司号',
      builtin: false,
      codex: {
        status: 'ready',
        identity: { userId: 'company-user', workspaceId: 'company-workspace', email: 'company@example.test' },
      },
    };
    accountResponse.providers.push(managed);
    mockApiFetch.mockImplementation((path: string) => {
      paths.push(path);
      if (path === '/api/accounts') return Promise.resolve(jsonResponse(accountResponse));
      if (path === `/api/accounts/${managedRef}/codex/quota`) {
        return Promise.resolve(
          jsonResponse({
            accountRef: managedRef,
            quota: suppliedQuota,
          }),
        );
      }
      if (path.startsWith('/api/quota/refresh/')) return Promise.resolve(jsonResponse({ ok: true }));
      return defaultQuotaApiFetch(path);
    });
    await act(async () => {
      root.render(React.createElement(HubQuotaBoardTab));
    });
    await flushEffects();
    const card = () =>
      Array.from(container.querySelectorAll('span')).find((node) => node.textContent?.trim() === '公司号')
        ?.parentElement?.parentElement;
    expect(card()?.textContent).not.toContain('100% 剩余');
    expect(card()?.textContent).toContain('尚未查询');
    const button = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent?.trim() === '刷新全部',
    );
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    expect(paths).toContain(`/api/accounts/${managedRef}/codex/quota`);
    expect(card()?.textContent).toContain('公司号额度');
    expect(card()?.textContent).toContain('32% 剩余');
    expect(card()?.textContent).not.toContain('100% 剩余');
    suppliedQuota = { ...successfulQuota, status: 'unavailable', items: [], error: '公司号查询暂不可用' };
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    expect(card()?.textContent).toContain('公司号查询暂不可用');
    expect(card()?.textContent).not.toContain('32% 剩余');
    expect(card()?.textContent).not.toContain('100% 剩余');
    suppliedQuota = successfulQuota;
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    expect(card()?.textContent).toContain('32% 剩余');
    expect(container.textContent).not.toContain('公司号查询暂不可用');
  });

  it.each([
    'identity_changed',
    'not_logged_in',
  ])('stops displaying a successful quota when login becomes %s', async (status) => {
    const accounts = await (await defaultQuotaApiFetch('/api/accounts')).json();
    const profile = {
      ...accounts.providers.find((entry: { clientId?: string }) => entry.clientId === 'openai'),
      id: 'managed-transition',
      displayName: '失效公司号',
      builtin: false,
      codex: { status: 'ready', identity: { userId: 'user-a', workspaceId: 'workspace-a' } },
      quota: {
        status: 'ok',
        source: 'codex_official_readonly',
        observedAt: 1772470000000,
        owner: { accountRef: 'managed-transition', userId: 'user-a', workspaceId: 'workspace-a' },
        items: [{ label: '旧身份额度', usedPercent: 99, percentKind: 'used' }],
      },
    };
    accounts.providers = [profile];
    mockApiFetch.mockImplementation((path) =>
      path === '/api/accounts' ? Promise.resolve(jsonResponse(accounts)) : defaultQuotaApiFetch(path),
    );
    await act(async () => root.render(React.createElement(HubQuotaBoardTab)));
    await flushEffects();
    expect(container.textContent).toContain('旧身份额度');
    profile.codex.status = status;
    await act(async () => window.dispatchEvent(new Event('accounts-changed')));
    await flushEffects();
    expect(container.textContent).not.toContain('旧身份额度');
    expect(container.textContent).toContain(status === 'identity_changed' ? '登录身份已变化' : '尚未登录');
  });

  it('does not project a late workspace-a quota into the same account ref now owned by workspace-b', async () => {
    const accounts = await (await defaultQuotaApiFetch('/api/accounts')).json();
    const profile = {
      ...accounts.providers.find((entry: { clientId?: string }) => entry.clientId === 'openai'),
      id: 'managed-transition',
      displayName: '换身份公司号',
      builtin: false,
      codex: { status: 'ready', identity: { userId: 'user-a', workspaceId: 'workspace-a' } },
    };
    accounts.providers = [profile];
    const oldAccounts = structuredClone(accounts);
    let finishOldList: (response: Response) => void = () => {};
    const oldList = new Promise<Response>((resolve) => {
      finishOldList = resolve;
    });
    let listReads = 0;
    let finish: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    mockApiFetch.mockImplementation((path) =>
      path === '/api/accounts'
        ? ++listReads === 2
          ? oldList
          : Promise.resolve(jsonResponse(accounts))
        : path === '/api/accounts/managed-transition/codex/quota'
          ? pending
          : defaultQuotaApiFetch(path),
    );
    await act(async () => root.render(React.createElement(HubQuotaBoardTab)));
    await flushEffects();
    const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === '刷新全部');
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => window.dispatchEvent(new Event('accounts-changed')));
    profile.codex.identity = { userId: 'user-b', workspaceId: 'workspace-b' };
    await act(async () => window.dispatchEvent(new Event('accounts-changed')));
    await flushEffects();
    await act(async () => finishOldList(jsonResponse(oldAccounts)));
    await act(async () =>
      finish(
        jsonResponse({
          accountRef: profile.id,
          quota: {
            status: 'ok',
            source: 'codex_official_readonly',
            observedAt: 1772470000000,
            owner: { accountRef: profile.id, userId: 'user-a', workspaceId: 'workspace-a' },
            items: [{ label: '旧身份额度', usedPercent: 99, percentKind: 'used' }],
          },
        }),
      ),
    );
    await flushEffects();
    expect(container.textContent).not.toContain('旧身份额度');
  });

  it('shows the managed account failure rather than another account quota and does not query an unready login', async () => {
    const paths: string[] = [];
    const accountResponse = await (await defaultQuotaApiFetch('/api/accounts')).json();
    accountResponse.providers = [
      {
        ...accountResponse.providers.find((profile: { clientId?: string }) => profile.clientId === 'openai'),
        id: 'codex-not-ready',
        displayName: '未完成登录号',
        builtin: false,
        codex: { status: 'not_logged_in' },
        quota: { status: 'unavailable', error: '此账号查询失败', items: [], observedAt: 1772470000000 },
      },
    ];
    mockApiFetch.mockImplementation((path: string) => {
      paths.push(path);
      if (path === '/api/accounts') return Promise.resolve(jsonResponse(accountResponse));
      return defaultQuotaApiFetch(path);
    });
    await act(async () => {
      root.render(React.createElement(HubQuotaBoardTab));
    });
    await flushEffects();
    expect(container.textContent).toContain('尚未登录');
    expect(container.textContent).not.toContain('100% 剩余');
    const button = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent?.trim() === '刷新全部',
    );
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    expect(paths).not.toContain('/api/accounts/codex-not-ready/codex/quota');
    expect(paths).not.toContain('/api/quota/refresh/official');
  });

  it.each([
    'identity_changed',
    'not_logged_in',
    'new_identity',
    'ready',
  ])('reconciles an in-flight successful list after quota projection when login becomes %s', async (status) => {
    const accounts = await (await defaultQuotaApiFetch('/api/accounts')).json();
    const profile = {
      ...accounts.providers.find((entry: { clientId?: string }) => entry.clientId === 'openai'),
      id: 'managed-in-flight',
      displayName: '在途公司号',
      builtin: false,
      codex: { status: 'ready', identity: { userId: 'user-a', workspaceId: 'workspace-a' } },
    };
    accounts.providers = [profile];
    const observation = {
      status: 'ok',
      source: 'codex_official_readonly',
      observedAt: 1772470000000,
      owner: { accountRef: profile.id, userId: 'user-a', workspaceId: 'workspace-a' },
      items: [{ label: '旧身份额度', usedPercent: 99, percentKind: 'used' }],
    };
    let releaseList: (response: Response) => void = () => {};
    const inFlightList = new Promise<Response>((resolve) => {
      releaseList = resolve;
    });
    let listReads = 0;
    mockApiFetch.mockImplementation((path) => {
      if (path === '/api/accounts') return ++listReads === 1 ? Promise.resolve(jsonResponse(accounts)) : inFlightList;
      if (path === `/api/accounts/${profile.id}/codex/quota`)
        return Promise.resolve(jsonResponse({ accountRef: profile.id, quota: observation }));
      return defaultQuotaApiFetch(path);
    });
    await act(async () => root.render(React.createElement(HubQuotaBoardTab)));
    await flushEffects();
    await act(async () => window.dispatchEvent(new Event('accounts-changed')));
    expect(listReads).toBe(2);
    const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === '刷新全部');
    await act(async () => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flushEffects();
    expect(container.textContent).toContain('旧身份额度');
    expect(container.textContent).toContain('1% 剩余');
    profile.codex.status = status === 'new_identity' ? 'ready' : status;
    if (status === 'new_identity') profile.codex.identity = { userId: 'user-b', workspaceId: 'workspace-b' };
    await act(async () => releaseList(jsonResponse(accounts)));
    await flushEffects();
    if (status === 'ready') {
      expect(container.textContent).toContain('旧身份额度');
      expect(container.textContent).toContain('1% 剩余');
    } else {
      expect(container.textContent).not.toContain('旧身份额度');
      expect(container.textContent).not.toContain('1% 剩余');
      expect(container.textContent).toContain(
        status === 'identity_changed' ? '登录身份已变化' : status === 'not_logged_in' ? '尚未登录' : '尚未查询',
      );
    }
  });

  it.each([
    'non-ok',
    'throw',
  ])('ignores a late list %s after quota projection while retaining subsequent list errors', async (failure) => {
    const accountResponse = await (await defaultQuotaApiFetch('/api/accounts')).json();
    accountResponse.providers = [
      {
        ...accountResponse.providers.find((profile: { clientId?: string }) => profile.clientId === 'openai'),
        id: 'codex-managed-fixture',
        displayName: '公司号',
        builtin: false,
        codex: { status: 'ready', identity: { userId: 'company-user', workspaceId: 'company-workspace' } },
      },
    ];
    let readCount = 0;
    let releaseList: (response: Response) => void = () => {};
    let rejectList: (error: Error) => void = () => {};
    const staleList = new Promise<Response>((resolve, reject) => {
      releaseList = resolve;
      rejectList = reject;
    });
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        readCount++;
        if (readCount === 2) return staleList;
        if (readCount === 3) return Promise.resolve(new Response('{}', { status: 503 }));
        return Promise.resolve(jsonResponse(accountResponse));
      }
      if (path === '/api/accounts/codex-managed-fixture/codex/quota')
        return Promise.resolve(
          jsonResponse({
            accountRef: 'codex-managed-fixture',
            quota: {
              owner: { accountRef: 'codex-managed-fixture', userId: 'company-user', workspaceId: 'company-workspace' },
              status: 'ok',
              source: 'codex_official_readonly',
              observedAt: 1772470000000,
              items: [{ label: '公司号额度', usedPercent: 32, percentKind: 'remaining' }],
            },
          }),
        );
      return defaultQuotaApiFetch(path);
    });
    await act(async () => {
      root.render(React.createElement(HubQuotaBoardTab));
    });
    await flushEffects();
    await act(async () => {
      window.dispatchEvent(new Event('accounts-changed'));
    });
    await flushEffects();
    const button = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent?.trim() === '刷新全部',
    );
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    expect(container.textContent).toContain('32% 剩余');
    await act(async () => {
      if (failure === 'throw') rejectList(new Error('stale list failed'));
      else releaseList(new Response('{}', { status: 503 }));
    });
    await flushEffects();
    expect(container.textContent).toContain('32% 剩余');
    expect(container.textContent).not.toContain('账号配置加载失败');
    await act(async () => window.dispatchEvent(new Event('accounts-changed')));
    await flushEffects();
    expect(container.textContent).toContain('账号配置加载失败 (503)');
    await act(async () => window.dispatchEvent(new Event('accounts-changed')));
    await flushEffects();
    expect(container.textContent).not.toContain('账号配置加载失败');
    expect(container.textContent).toContain('32% 剩余');
  });

  it('groups quota by account pool and shows reverse-linked member chips after data loads', async () => {
    await act(async () => {
      root.render(React.createElement(HubQuotaBoardTab));
    });
    await flushEffects();

    expect(container.textContent).toContain('OAuth 账号额度（按账号配置）');
    expect(container.textContent).toContain('API Key 额度（按账号配置）');
    expect(container.textContent).toContain('Claude (OAuth)');
    expect(container.textContent).toContain('Codex (OAuth)');
    expect(container.textContent).toContain('Gemini (OAuth)');
    expect(container.textContent).toContain('Codex Sponsor');
    expect(container.textContent).toContain('@opus');
    expect(container.textContent).toContain('@codex');
    expect(container.textContent).toContain('@spark');
    expect(container.textContent).toContain('Antigravity Bridge（独立通道）');
    expect(container.textContent).toContain('@antigravity');
    expect(container.textContent).toContain('从猫粮看板改名为配额看板');
    expect(container.textContent).not.toContain('Claude 订阅');
    expect(container.textContent).not.toContain('Codex 订阅');
    expect(container.textContent).not.toContain('Gemini 订阅');
    expect(container.textContent).not.toContain('缅因猫 Codex + GPT-5.2');
    expect(container.textContent).not.toContain('缅因猫 代码审查');
  });

  it('attributes unbound openai cats to the active openai profile pool', async () => {
    await act(async () => {
      root.render(React.createElement(HubQuotaBoardTab));
    });
    await flushEffects();

    const sectionLabel = (title: string) =>
      Array.from(container.querySelectorAll('span')).find((node) => node.textContent?.trim() === title);

    const sponsorHeader = sectionLabel('Codex Sponsor');
    const codexOauthHeader = sectionLabel('Codex (OAuth)');

    expect(sponsorHeader).toBeTruthy();
    expect(codexOauthHeader).toBeTruthy();
    expect(sponsorHeader?.parentElement?.textContent ?? '').toContain('@spark');
    expect(codexOauthHeader?.parentElement?.textContent ?? '').toContain('@codex');
  });

  it('shows a visible error banner when quota loading fails', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/quota') return Promise.resolve(new Response('{}', { status: 503 }));
      return defaultQuotaApiFetch(path);
    });

    await act(async () => {
      root.render(React.createElement(HubQuotaBoardTab));
    });
    await flushEffects();

    expect(container.textContent).toContain('配额数据加载失败 (503)');
    expect(container.textContent).toContain('显示的可能是过期数据');
  });

  it('shows a visible error banner when provider profiles fail to load', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') return Promise.resolve(new Response('{}', { status: 503 }));
      return defaultQuotaApiFetch(path);
    });

    await act(async () => {
      root.render(React.createElement(HubQuotaBoardTab));
    });
    await flushEffects();

    expect(container.textContent).toContain('账号配置加载失败 (503)');
    expect(container.textContent).toContain('额度池成员归属可能不完整');
  });

  it('refreshes only providers represented by configured subscription accounts', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path === '/api/quota/refresh/official') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (path === '/api/quota/refresh/claude') {
        return Promise.resolve(jsonResponse({ claude: { platform: 'claude' } }));
      }
      if (path === '/api/quota/refresh/kimi') {
        return Promise.resolve(jsonResponse({ kimi: { status: 'ok' }, source: 'cli', fallbackUsed: false }));
      }
      return defaultQuotaApiFetch(path);
    });

    await act(async () => {
      root.render(React.createElement(HubQuotaBoardTab));
    });
    await flushEffects();
    calls.length = 0;

    const refreshButton = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent?.trim() === '刷新全部',
    );
    expect(refreshButton).toBeTruthy();

    await act(async () => {
      refreshButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(calls.map((call) => call.path)).toContain('/api/quota/refresh/official');
    expect(calls.map((call) => call.path)).toContain('/api/quota/refresh/claude');
    expect(calls.map((call) => call.path)).not.toContain('/api/quota/refresh/kimi');
    const officialCall = calls.find((call) => call.path === '/api/quota/refresh/official');
    expect(JSON.parse(String(officialCall?.init?.body))).toEqual({
      interactive: true,
      providers: ['claude', 'codex'],
    });
    for (const call of calls.filter((entry) => entry.path.startsWith('/api/quota/refresh/'))) {
      expect(call.init?.body).toBeTruthy();
      expect(new Headers(call.init?.headers).get('content-type')).toBe('application/json');
    }
  });

  it('surfaces partial official warnings returned with HTTP 200', async () => {
    const warning = 'Claude OAuth failed: upstream unavailable';
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/quota/refresh/official') {
        return Promise.resolve(jsonResponse({ ok: true, codexItems: 1, claudeItems: 0, warnings: [warning] }));
      }
      if (path === '/api/quota/refresh/claude') {
        return Promise.resolve(jsonResponse({ claude: { platform: 'claude' } }));
      }
      return defaultQuotaApiFetch(path);
    });

    await act(async () => {
      root.render(React.createElement(HubQuotaBoardTab));
    });
    await flushEffects();

    const refreshButton = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent?.trim() === '刷新全部',
    );
    await act(async () => {
      refreshButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.textContent).toContain(warning);
  });

  it('refreshes only Codex for the current Codex OAuth plus DeepSeek API-key configuration', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            providers: [
              {
                id: 'my-codex-account',
                clientId: 'openai',
                displayName: 'my-codex-account',
                name: 'my-codex-account',
                authType: 'oauth',
                builtin: true,
                mode: 'subscription',
                hasApiKey: false,
                createdAt: '',
                updatedAt: '',
              },
              {
                id: 'my-deepseek-account',
                displayName: 'my-deepseek-account',
                name: 'my-deepseek-account',
                authType: 'api_key',
                builtin: false,
                mode: 'api_key',
                hasApiKey: true,
                createdAt: '',
                updatedAt: '',
              },
            ],
          }),
        );
      }
      if (path === '/api/quota/refresh/official') return Promise.resolve(jsonResponse({ ok: true }));
      return defaultQuotaApiFetch(path);
    });

    await act(async () => {
      root.render(React.createElement(HubQuotaBoardTab));
    });
    await flushEffects();

    const codexAccountLabel = Array.from(container.querySelectorAll('span')).find(
      (node) => node.textContent?.trim() === 'my-codex-account',
    );
    const codexAccountCard = codexAccountLabel?.parentElement?.parentElement;
    expect(codexAccountCard).toBeTruthy();
    expect(codexAccountCard?.textContent).toContain('5小时使用限额');
    expect(codexAccountCard?.textContent).toContain('100% 剩余');

    calls.length = 0;

    const refreshButton = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent?.trim() === '刷新全部',
    );
    await act(async () => {
      refreshButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(calls.map((call) => call.path)).toEqual(['/api/quota/refresh/official', '/api/quota']);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ interactive: true, providers: ['codex'] });
  });

  it('does not surface cached Kimi failures when Kimi is not configured', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/quota') {
        return Promise.resolve(
          jsonResponse({
            ...MOCK_QUOTA_RESPONSE,
            kimi: {
              platform: 'kimi',
              usageItems: [],
              error: 'Kimi CLI should not have been called',
              lastChecked: '2026-07-18T06:40:00.000Z',
            },
          }),
        );
      }
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            providers: [
              {
                id: 'my-codex-account',
                clientId: 'openai',
                displayName: 'my-codex-account',
                name: 'my-codex-account',
                authType: 'oauth',
                builtin: true,
                mode: 'subscription',
                hasApiKey: false,
                createdAt: '',
                updatedAt: '',
              },
            ],
          }),
        );
      }
      return defaultQuotaApiFetch(path);
    });

    await act(async () => {
      root.render(React.createElement(HubQuotaBoardTab));
    });
    await flushEffects();

    expect(container.textContent).not.toContain('Kimi CLI should not have been called');
  });
});

describe('HubQuotaBoardTab — polling & notification', () => {
  it('exports POLL_INTERVAL_MS for periodic refresh', async () => {
    const mod = await import('@/components/HubQuotaBoardTab');
    expect(mod.POLL_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
    expect(mod.POLL_INTERVAL_MS).toBeLessThanOrEqual(60_000);
  });

  it('sends quota risk notification on first high-risk transition', async () => {
    const mod = await import('@/components/HubQuotaBoardTab');
    expect(
      mod.shouldSendQuotaRiskNotification({
        currentRisk: 'high',
        previousRisk: 'warn',
        lastAlertAt: 0,
        nowMs: 1_000,
      }),
    ).toBe(true);
  });

  it('dedupes repeated high-risk notifications within time window', async () => {
    const mod = await import('@/components/HubQuotaBoardTab');
    expect(
      mod.shouldSendQuotaRiskNotification({
        currentRisk: 'high',
        previousRisk: 'high',
        lastAlertAt: 1_000,
        nowMs: 1_000 + mod.QUOTA_ALERT_DEDUPE_WINDOW_MS - 1,
      }),
    ).toBe(false);
    expect(
      mod.shouldSendQuotaRiskNotification({
        currentRisk: 'high',
        previousRisk: 'high',
        lastAlertAt: 1_000,
        nowMs: 1_000 + mod.QUOTA_ALERT_DEDUPE_WINDOW_MS + 1,
      }),
    ).toBe(true);
  });
});

describe('quota-cards — pool grouping and row rendering', () => {
  it('groups codex items by poolId', async () => {
    const { groupCodexByPool } = await import('@/components/quota-cards');
    const pools = groupCodexByPool(MOCK_QUOTA_RESPONSE.codex.usageItems);
    expect(pools).toHaveLength(3);
    expect(pools[0].poolId).toBe('codex-main');
    expect(pools[0].displayName).toContain('Codex');
    expect(pools[0].items).toHaveLength(2);
    expect(pools[1].poolId).toBe('codex-spark');
    expect(pools[1].displayName).toContain('Spark');
    expect(pools[1].items).toHaveLength(2);
    expect(pools[2].poolId).toBe('codex-review');
    expect(pools[2].displayName).toContain('代码审查');
    expect(pools[2].items).toHaveLength(1);
  });

  it('renders remaining percent directly in QuotaPoolRow', async () => {
    const { QuotaPoolRow } = await import('@/components/quota-cards');
    const html = renderToStaticMarkup(
      React.createElement(QuotaPoolRow, {
        item: { label: '每周使用限额', usedPercent: 97, percentKind: 'remaining', poolId: 'codex-main' },
      }),
    );
    expect(html).toContain('97%');
    expect(html).toContain('剩余');
  });

  it('converts used percentages to remaining percentages for a consistent display', async () => {
    const { QuotaPoolRow } = await import('@/components/quota-cards');
    const html = renderToStaticMarkup(
      React.createElement(QuotaPoolRow, {
        item: { label: '每周使用限额', usedPercent: 27, percentKind: 'used', poolId: 'codex-main' },
      }),
    );
    expect(html).toContain('73% 剩余');
    expect(html).not.toContain('27% 已用');
  });

  it('progress bar uses green for healthy remaining (97%), red for low remaining (10%)', async () => {
    const { QuotaPoolRow } = await import('@/components/quota-cards');
    // 97% remaining = 3% used = healthy → should be green
    const healthyHtml = renderToStaticMarkup(
      React.createElement(QuotaPoolRow, {
        item: { label: 'test', usedPercent: 97, percentKind: 'remaining' },
      }),
    );
    expect(healthyHtml).toContain('bg-[var(--semantic-success)]');
    expect(healthyHtml).not.toContain('bg-rose-500');

    // 10% remaining = 90% used = danger → should be red
    const dangerHtml = renderToStaticMarkup(
      React.createElement(QuotaPoolRow, {
        item: { label: 'test', usedPercent: 10, percentKind: 'remaining' },
      }),
    );
    expect(dangerHtml).toContain('bg-rose-500');
    expect(dangerHtml).not.toContain('bg-[var(--semantic-success)]');
  });

  it('renders resetsAt as formatted time when resetsText is absent', async () => {
    const { QuotaPoolRow } = await import('@/components/quota-cards');
    const html = renderToStaticMarkup(
      React.createElement(QuotaPoolRow, {
        item: { label: 'Gemini Pro', usedPercent: 10, percentKind: 'used', resetsAt: '2026-03-05T19:00:00Z' },
      }),
    );
    // Should show some formatted reset time (not empty)
    expect(html).toMatch(/resets|重置|Mar|3月|19:00/i);
  });

  it('shows degradation hint when utilization >= 80%', async () => {
    const { degradationHint } = await import('@/components/quota-cards');
    expect(degradationHint('codex-review', 80)).toContain('@gpt52');
    expect(degradationHint('codex-main', 85)).toContain('@spark');
    expect(degradationHint('claude-session', 90)).toContain('Sonnet');
    expect(degradationHint('codex-main', 50)).toBeNull();
  });

  it('computes utilization correctly for remaining vs used', async () => {
    const { toUtilization } = await import('@/components/quota-cards');
    expect(toUtilization({ label: 'x', usedPercent: 80, percentKind: 'remaining' })).toBe(20);
    expect(toUtilization({ label: 'x', usedPercent: 54 })).toBe(54);
  });
});
