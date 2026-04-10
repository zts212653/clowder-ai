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
    source: 'seed',
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
    source: 'seed',
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
    source: 'runtime',
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
    source: 'seed',
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
    source: 'seed',
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
            protocol: 'anthropic',
            builtin: true,
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
            protocol: 'openai',
            builtin: true,
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
            protocol: 'google',
            builtin: true,
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
            protocol: 'openai',
            builtin: false,
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
    expect(html).toContain('内置账号额度（按账号配置）');
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

  it('groups quota by account pool and shows reverse-linked member chips after data loads', async () => {
    await act(async () => {
      root.render(React.createElement(HubQuotaBoardTab));
    });
    await flushEffects();

    expect(container.textContent).toContain('内置账号额度（按账号配置）');
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

  it('progress bar uses green for healthy remaining (97%), red for low remaining (10%)', async () => {
    const { QuotaPoolRow } = await import('@/components/quota-cards');
    // 97% remaining = 3% used = healthy → should be green
    const healthyHtml = renderToStaticMarkup(
      React.createElement(QuotaPoolRow, {
        item: { label: 'test', usedPercent: 97, percentKind: 'remaining' },
      }),
    );
    expect(healthyHtml).toContain('bg-emerald-500');
    expect(healthyHtml).not.toContain('bg-rose-500');

    // 10% remaining = 90% used = danger → should be red
    const dangerHtml = renderToStaticMarkup(
      React.createElement(QuotaPoolRow, {
        item: { label: 'test', usedPercent: 10, percentKind: 'remaining' },
      }),
    );
    expect(dangerHtml).toContain('bg-rose-500');
    expect(dangerHtml).not.toContain('bg-emerald-500');
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
