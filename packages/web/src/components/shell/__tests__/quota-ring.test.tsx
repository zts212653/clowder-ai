import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ push: vi.fn(), pathname: '/thread/current' }));
const apiMock = vi.hoisted(() => ({
  pinPref: { pinned: true, selectedAccountRefs: null as string[] | null },
  accounts: [] as Record<string, unknown>[],
  codexSelection: { state: 'selected' as const, accountRef: 'codex-pro', members: [] as unknown[] },
  claudeSelection: { state: 'selected' as const, accountRef: 'claude', members: [] as unknown[] },
  agySelection: { state: 'selected' as const, accountRef: 'agy-1', members: [] as unknown[] },
  kimiQuota: {
    platform: 'kimi',
    status: 'ok' as 'ok' | 'unavailable',
    lastChecked: new Date().toISOString(),
    usageItems: [
      {
        label: '5小时使用限额',
        usedPercent: 9,
        percentKind: 'used',
        poolId: 'kimi-rate-limit',
        resetsText: 'Resets in 1h 7m',
      },
      {
        label: '每周使用限额',
        usedPercent: 38,
        percentKind: 'used',
        poolId: 'kimi-weekly',
        resetsText: 'Resets in 3d 15h',
      },
    ],
  },
  calls: [] as Array<{ url: string; method: string; body?: unknown }>,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: nav.push }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [
      {
        id: 'codex61-sol',
        name: 'Sol',
        displayName: 'Sol',
        nickname: '小太阳',
        clientId: 'openai',
        cli: 'codex',
        roster: { available: true },
      },
      {
        id: 'fable-5',
        name: 'Fable',
        displayName: 'Fable',
        nickname: '宪宪',
        clientId: 'anthropic',
        cli: 'claude',
        roster: { available: true },
      },
      {
        id: 'gemini-carbon',
        name: 'Carbon',
        displayName: 'Carbon',
        nickname: '碳碳',
        clientId: 'google',
        cli: 'agy',
        roster: { available: true },
      },
      {
        id: 'kimi31-pro',
        name: 'Kimi',
        displayName: '梵花猫',
        nickname: '墨墨',
        clientId: 'kimi',
        accountRef: 'kimi-code-native',
        cli: 'kimi',
        roster: { available: true },
      },
    ],
    loading: false,
  }),
}));
vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : undefined;
    apiMock.calls.push({ url, method, body });
    if (url === '/api/config/quota-pin') {
      if (method === 'PUT' && body && typeof body === 'object') {
        apiMock.pinPref = { ...apiMock.pinPref, ...(body as Partial<typeof apiMock.pinPref>) };
      }
      return new Response(JSON.stringify(apiMock.pinPref), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith('/api/accounts/codex/members')) {
      return new Response(JSON.stringify({ selection: apiMock.codexSelection }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith('/api/accounts/claude/members')) {
      return new Response(JSON.stringify({ selection: apiMock.claudeSelection }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith('/api/accounts/agy/members')) {
      return new Response(JSON.stringify({ selection: apiMock.agySelection }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === '/api/quota') {
      return new Response(
        JSON.stringify({
          claude: { platform: 'claude', recentBlocks: [], activeBlock: null, lastChecked: null },
          codex: { platform: 'codex', usageItems: [], lastChecked: null },
          gemini: { platform: 'gemini', usageItems: [], lastChecked: null },
          kimi: apiMock.kimiQuota,
          antigravity: { platform: 'antigravity', usageItems: [], lastChecked: null },
          fetchedAt: new Date().toISOString(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url === '/api/accounts' || url.startsWith('/api/accounts?')) {
      return new Response(JSON.stringify({ projectPath: '/cafe', providers: apiMock.accounts }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === '/api/accounts/codex-pro/codex/quota' && method === 'POST') {
      const updated = {
        owner: { accountRef: 'codex-pro', userId: 'u-1', workspaceId: 'ws-1' },
        observedAt: Date.now(),
        status: 'ok',
        source: 'codex_official_readonly',
        items: [
          {
            label: '每周使用限额',
            usedPercent: 35,
            percentKind: 'used',
            poolId: 'codex-main',
            resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        ],
      };
      apiMock.accounts = apiMock.accounts.map((acc) => (acc.id === 'codex-pro' ? { ...acc, quota: updated } : acc));
      return new Response(JSON.stringify({ accountRef: 'codex-pro', quota: updated }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === '/api/accounts/claude/claude/quota' && method === 'POST') {
      const claudeQuota = {
        samples: {
          'claude-fable-5-2': {
            observedAt: Date.now(),
            windows: {
              seven_day: {
                utilization: 0.2,
                resetsAt: Math.floor((Date.now() + 86_400_000) / 1000),
                status: 'allowed',
              },
            },
          },
        },
      };
      apiMock.accounts = apiMock.accounts.map((acc) => (acc.id === 'claude' ? { ...acc, claudeQuota } : acc));
      return new Response(JSON.stringify({ claudeQuota }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === '/api/accounts/kimi-code-native/kimi/quota' && method === 'POST') {
      const nowMs = Date.now();
      const kimiQuota = {
        owner: { accountRef: 'kimi-code-native', credentialVersion: 'cv-kimi-native' },
        observedAt: nowMs,
        items: [
          {
            label: '每周使用限额',
            usedPercent: 12,
            percentKind: 'used',
            poolId: 'kimi-weekly',
            resetsText: 'Resets in 6d',
            resetsAt: new Date(nowMs + 6 * 86_400_000).toISOString(),
          },
        ],
      };
      apiMock.accounts = apiMock.accounts.map((acc) => (acc.id === 'kimi-code-native' ? { ...acc, kimiQuota } : acc));
      return new Response(JSON.stringify({ accountRef: 'kimi-code-native', kimiQuota }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === '/api/accounts/agy-1/agy/quota' && method === 'POST') {
      const nowMs = Date.now();
      const agyQuota = {
        owner: { accountRef: 'agy-1', credentialVersion: 'cv-agy-1' },
        observedAt: nowMs,
        items: [
          {
            label: 'Gemini · 每周使用限额',
            usedPercent: 49,
            percentKind: 'remaining',
            poolId: 'agy-gemini',
            resetsAt: new Date(nowMs + 3 * 86_400_000).toISOString(),
          },
          {
            label: 'Claude / GPT · 每周使用限额',
            usedPercent: 98,
            percentKind: 'remaining',
            poolId: 'agy-claude-gpt',
            resetsAt: new Date(nowMs + 2 * 86_400_000).toISOString(),
          },
        ],
      };
      apiMock.accounts = apiMock.accounts.map((acc) =>
        acc.id === 'agy-1' ? { ...acc, agyQuotaReady: true, agyQuota } : acc,
      );
      return new Response(JSON.stringify({ accountRef: 'agy-1', agyQuota }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
  }),
}));

import { HubAccountsTab } from '@/components/HubAccountsTab';
import type { ProfileItem } from '@/components/hub-accounts.types';
import { QuotaRingButton } from '../QuotaRingButton';
import { buildQuotaRingModel } from '../quota-pin/quota-pin-model';
import {
  getQuotaPinStoreSnapshot,
  resetQuotaPinStoreForTests,
  updateQuotaPinPreference,
} from '../quota-pin/quota-pin-store';

describe('QuotaRingButton 4-family vertical bars and grouped popover', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    resetQuotaPinStoreForTests();
    nav.pathname = '/thread/current';
    apiMock.calls = [];
    apiMock.pinPref = { pinned: true, selectedAccountRefs: null };
    const now = Date.now();
    apiMock.kimiQuota = {
      platform: 'kimi',
      status: 'ok',
      lastChecked: new Date(now - 60_000).toISOString(),
      usageItems: [
        {
          label: '5小时使用限额',
          usedPercent: 9,
          percentKind: 'used',
          poolId: 'kimi-rate-limit',
          resetsText: 'Resets in 1h 7m',
        },
        {
          label: '每周使用限额',
          usedPercent: 38,
          percentKind: 'used',
          poolId: 'kimi-weekly',
          resetsText: 'Resets in 3d 15h',
        },
      ],
    };
    apiMock.accounts = [
      {
        id: 'codex-pro',
        name: 'Codex Pro 主号',
        displayName: 'Codex Pro 主号',
        authType: 'oauth',
        clientId: 'openai',
        builtin: false,
        kind: 'oauth',
        mode: 'subscription',
        models: [],
        hasApiKey: false,
        createdAt: '',
        updatedAt: '',
        codex: {
          kind: 'managed',
          layoutVersion: 1,
          credentialHome: '/tmp/codex-pro',
          stateRoot: '/tmp/state',
          sqliteHome: '/tmp/sqlite',
          prepared: true,
          status: 'ready',
          identity: { userId: 'u-1', workspaceId: 'ws-1', planType: 'pro' },
        },
        quota: {
          owner: { accountRef: 'codex-pro', userId: 'u-1', workspaceId: 'ws-1' },
          observedAt: now - 3 * 3600_000,
          status: 'ok',
          source: 'codex_official_readonly',
          items: [
            {
              label: '每周使用限额',
              usedPercent: 40,
              percentKind: 'used',
              poolId: 'codex-main',
              resetsAt: new Date(now + 2 * 86_400_000).toISOString(),
            },
          ],
        },
      },
      {
        id: 'codex-bak',
        name: 'Codex 备用二号',
        displayName: 'Codex 备用二号',
        authType: 'oauth',
        clientId: 'openai',
        builtin: false,
        kind: 'oauth',
        mode: 'subscription',
        models: [],
        hasApiKey: false,
        createdAt: '',
        updatedAt: '',
        codex: {
          kind: 'managed',
          layoutVersion: 1,
          credentialHome: '/tmp/codex-bak',
          stateRoot: '/tmp/state',
          sqliteHome: '/tmp/sqlite',
          prepared: true,
          status: 'ready',
          identity: { userId: 'u-2', workspaceId: 'ws-2', planType: 'pro' },
        },
        quota: {
          owner: { accountRef: 'codex-bak', userId: 'u-2', workspaceId: 'ws-2' },
          observedAt: now - 600_000,
          status: 'ok',
          source: 'codex_official_readonly',
          items: [
            {
              label: '每周使用限额',
              usedPercent: 8,
              percentKind: 'used',
              poolId: 'codex-main',
              resetsAt: new Date(now + 5 * 86_400_000).toISOString(),
            },
          ],
        },
      },
      {
        id: 'claude',
        name: 'Claude (OAuth)',
        displayName: 'Claude (OAuth)',
        authType: 'oauth',
        clientId: 'anthropic',
        builtin: true,
        kind: 'builtin',
        mode: 'subscription',
        models: [],
        hasApiKey: false,
        createdAt: '',
        updatedAt: '',
        claudeQuota: {
          samples: {
            'claude-fable-5-2': {
              observedAt: now - 120_000,
              windows: {
                seven_day: {
                  utilization: 0.96,
                  resetsAt: Math.floor((now + 86_400_000) / 1000),
                  status: 'allowed_warning',
                },
              },
            },
          },
        },
      },
      {
        id: 'agy-1',
        name: 'Gemini AGY 号',
        displayName: 'Gemini AGY 号',
        authType: 'oauth',
        clientId: 'google',
        builtin: false,
        kind: 'oauth',
        mode: 'subscription',
        models: [],
        hasApiKey: false,
        createdAt: '',
        updatedAt: '',
        agy: { storage: 'cli_file', credentialHome: '/tmp/agy' },
        agyLoginStatus: 'ready',
      },
      {
        id: 'kimi-code-native',
        name: 'Kimi Code Native',
        displayName: 'Kimi Code Native',
        authType: 'oauth',
        clientId: 'kimi',
        builtin: false,
        kind: 'oauth',
        mode: 'subscription',
        models: [],
        hasApiKey: false,
        createdAt: '',
        updatedAt: '',
        kimiLoginReady: true,
        kimiQuota: {
          owner: { accountRef: 'kimi-code-native', credentialVersion: 'cv-kimi-native' },
          observedAt: now - 60_000,
          items: [
            {
              label: '5小时使用限额',
              usedPercent: 9,
              percentKind: 'used',
              poolId: 'kimi-rate-limit',
              resetsText: 'Resets in 1h 7m',
              resetsAt: new Date(now + 67 * 60_000).toISOString(),
            },
            {
              label: '每周使用限额',
              usedPercent: 38,
              percentKind: 'used',
              poolId: 'kimi-weekly',
              resetsText: 'Resets in 3d 15h',
              resetsAt: new Date(now + (3 * 24 + 15) * 3_600_000).toISOString(),
            },
          ],
        },
      },
    ];
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    for (const el of document.querySelectorAll('[data-testid="quota-ring-popover"]')) {
      el.remove();
    }
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders 4 vertical family bars (low red >=3.5h, normal family color, empty grey slot), 4-family hover summary, and family-grouped popover with standby rows', async () => {
    await act(async () => {
      root.render(<QuotaRingButton onOpenAccounts={() => nav.push('/settings?s=accounts')} />);
    });
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="quota-ring-button"]');
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('aria-label')).toContain('布偶 4%');
    expect(btn?.getAttribute('aria-label')).toContain('缅因 60%');
    expect(btn?.getAttribute('aria-label')).toContain('暹罗 —');
    expect(btn?.getAttribute('aria-label')).toContain('梵花 62%');

    const bars = [...(btn?.querySelectorAll('[data-bar-family]') ?? [])];
    expect(bars.map((b) => b.getAttribute('data-bar-family'))).toEqual(['claude', 'codex', 'agy', 'kimi']);
    expect(bars.map((b) => b.getAttribute('data-bar-state'))).toEqual(['low', 'ok', 'empty', 'ok']);

    // Claude at 4% (<20%) turns danger red with track opacity 0.55 and minimum nib height 3.5
    const claudeRects = bars[0]?.querySelectorAll('rect') ?? [];
    expect(claudeRects).toHaveLength(2);
    expect(claudeRects[0]?.getAttribute('fill-opacity')).toBe('0.55');
    expect(Number(claudeRects[1]?.getAttribute('height'))).toBeCloseTo(3.5, 2);

    // AGY with no reading is a single empty currentColor 16% slot (never drawn as 0% red)
    const agyRects = bars[2]?.querySelectorAll('rect') ?? [];
    expect(agyRects).toHaveLength(1);
    expect(agyRects[0]?.getAttribute('fill')).toBe('currentColor');
    expect(agyRects[0]?.getAttribute('fill-opacity')).toBe('0.16');

    // Opening popover does NOT trigger POST quota queries
    await act(async () => {
      btn?.click();
    });
    expect(apiMock.calls.filter((c) => c.method === 'POST')).toHaveLength(0);

    const popover = document.querySelector<HTMLElement>('[data-testid="quota-ring-popover"]');
    expect(popover).not.toBeNull();
    expect(popover?.getAttribute('data-chat-background-layer')).toBe('work');
    expect(popover?.getAttribute('data-chat-background-surface')).toBe('frame');
    expect(popover?.style.background).toContain('--shell-frame');
    expect(popover?.style.background).not.toContain('--shell-paper');

    // Grouped by family in canonical order; Codex group has active account first, standby one-liner second
    const familySections = [...(popover?.querySelectorAll<HTMLElement>('[data-quota-family]') ?? [])];
    expect(familySections.map((s) => s.getAttribute('data-quota-family'))).toEqual(['claude', 'codex', 'agy', 'kimi']);
    for (const sec of familySections) {
      expect(sec.getAttribute('data-chat-background-surface')).toBe('group');
      expect(sec.style.background).toContain('--shell-group');
    }

    const codexAccounts = [...(familySections[1]?.querySelectorAll('[data-quota-account]') ?? [])];
    expect(codexAccounts.map((el) => el.getAttribute('data-quota-account'))).toEqual(['codex-pro', 'codex-bak']);
    expect(codexAccounts[0]?.getAttribute('data-quota-role')).toBe('active');
    expect(codexAccounts[1]?.getAttribute('data-quota-role')).toBe('standby');
    expect(codexAccounts[1]?.textContent).toContain('Codex 备用二号');
    expect(codexAccounts[1]?.textContent).toContain('剩 92%');

    // Gemini AGY row must NOT render a fake meter
    const agyCard = popover?.querySelector('[data-quota-account="agy-1"]');
    expect(agyCard?.querySelector('[role="meter"]')).toBeNull();

    // Clicking Refresh queries Codex, Claude, AGY, AND Kimi
    const refreshBtn = popover?.querySelector<HTMLButtonElement>('[data-testid="quota-ring-refresh"]');
    await act(async () => {
      refreshBtn?.click();
    });
    const postUrls = apiMock.calls.filter((c) => c.method === 'POST').map((c) => c.url);
    expect(postUrls).toEqual(
      expect.arrayContaining([
        '/api/accounts/codex-pro/codex/quota',
        '/api/accounts/claude/claude/quota',
        '/api/accounts/agy-1/agy/quota',
        '/api/accounts/kimi-code-native/kimi/quota',
      ]),
    );
    expect(apiMock.calls.some((c) => c.url.startsWith('/api/quota'))).toBe(false);
    expect(popover?.textContent).toContain('剩 65%');
    expect(popover?.textContent).toContain('剩 80%');
    expect(popover?.textContent).toContain('Gemini · 本周');
    expect(popover?.textContent).toContain('剩 49%');
    expect(popover?.textContent).toContain('Claude / GPT · 本周');
    expect(popover?.textContent).toContain('剩 98%');
    expect(popover?.textContent).toContain('剩 88%');
  });

  it('keeps AGY Gemini and Claude/GPT pools strictly separated (Siamese bar uses ONLY Gemini pool, popover shows both) and refreshes passively when a same-page chat turn completes', async () => {
    const { useChatStore } = await import('@/stores/chatStore');
    const t0 = Date.UTC(2026, 10, 17, 8, 10, 0);

    // 1. Pure model check: Claude/GPT pool at 0% must NOT turn Siamese bar red; Gemini pool (49%) drives Siamese bar; missing resetsAt never fabricates a timestamp
    const model = buildQuotaRingModel({
      profiles: [
        {
          id: 'gemini',
          name: 'Gemini (OAuth)',
          displayName: 'Gemini (OAuth)',
          authType: 'oauth',
          clientId: 'google',
          builtin: true,
          kind: 'builtin',
          mode: 'subscription',
          models: [],
          hasApiKey: false,
          createdAt: '',
          updatedAt: '',
          agyQuotaReady: true,
          agyQuota: {
            owner: { accountRef: 'gemini', credentialVersion: 'cv-gemini-native' },
            observedAt: t0 - 30_000,
            items: [
              {
                label: 'Gemini · 每周使用限额',
                usedPercent: 48.6,
                percentKind: 'remaining',
                poolId: 'agy-gemini',
                resetsAt: new Date(t0 + 3 * 86_400_000).toISOString(),
              },
              {
                label: 'Gemini · 5小时使用限额',
                usedPercent: 100,
                percentKind: 'remaining',
                poolId: 'agy-gemini',
                // Unstarted window: no resetsAt supplied upstream
              },
              {
                label: 'Claude / GPT · 每周使用限额',
                usedPercent: 0,
                percentKind: 'remaining',
                poolId: 'agy-claude-gpt',
                resetsAt: new Date(t0 + 2 * 86_400_000).toISOString(),
              },
            ],
          },
        } as unknown as ProfileItem,
      ],
      cats: [],
      agySelection: { state: 'consensus', accountRef: 'gemini', members: [] },
      selectedAccountRefs: null,
      now: t0,
      language: 'zh',
    });

    const agyBar = model.summary.bars.find((b) => b.family === 'agy');
    expect(agyBar).toEqual({
      family: 'agy',
      remainingPercent: 49,
      low: false,
      exhausted: false,
    });
    const agyEntry = model.allEntries.find((e) => e.id === 'gemini');
    expect(agyEntry?.canRefresh).toBe(true);
    expect(agyEntry?.refreshKind).toBe('agy');
    expect(agyEntry?.windows.map((w) => [w.label, Math.round(w.remainingPercent ?? -1), w.exhausted])).toEqual([
      ['Gemini · 本周', 49, false],
      ['Gemini · 5 小时', 100, false],
      ['Claude / GPT · 本周', 0, true],
    ]);
    expect(agyEntry?.windows[1]?.resetsAtMs).toBeUndefined();
    expect(agyEntry?.windows[1]?.resetsText).toBeUndefined();

    // 2. Same-page passive update: while staying on Home without focus/click, finishing a chat invocation refreshes bars!
    useChatStore.setState({
      hasActiveInvocation: true,
      activeInvocations: { 'inv-live-1': 'codex61-sol' as never },
      catStatuses: { 'codex61-sol': 'streaming' },
    });
    await act(async () => {
      root.render(<QuotaRingButton onOpenAccounts={() => nav.push('/settings?s=accounts')} />);
    });
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="quota-ring-button"]');
    expect(btn?.getAttribute('aria-label')).toContain('缅因 60%');

    // Simulate backend recording updated passive Codex quota (e.g. 60% -> 42% remaining) before emitting done
    apiMock.accounts = apiMock.accounts.map((acc) =>
      acc.id === 'codex-pro'
        ? {
            ...acc,
            quota: {
              ...(acc.quota as Record<string, unknown>),
              observedAt: Date.now(),
              items: [
                {
                  label: '每周使用限额',
                  usedPercent: 58,
                  percentKind: 'used',
                  poolId: 'codex-main',
                  resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
                },
              ],
            },
          }
        : acc,
    );

    await act(async () => {
      useChatStore.setState({
        hasActiveInvocation: false,
        activeInvocations: {},
        catStatuses: { 'codex61-sol': 'done' },
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(btn?.getAttribute('aria-label')).toContain('缅因 42%');

    // 3. Standby AGY row with ONLY Claude/GPT pool windows must render "没有读数" (never unlabeled "剩 98%")
    apiMock.accounts = [
      ...apiMock.accounts,
      {
        id: 'agy-standby-claude-only',
        name: 'AGY 备用仅Claude池',
        displayName: 'AGY 备用仅Claude池',
        authType: 'oauth',
        clientId: 'google',
        builtin: false,
        kind: 'oauth',
        mode: 'subscription',
        models: [],
        hasApiKey: false,
        createdAt: '',
        updatedAt: '',
        agy: { storage: 'cli_file', credentialHome: '/tmp/agy-sb' },
        agyLoginStatus: 'ready',
        agyQuota: {
          owner: { accountRef: 'agy-standby-claude-only', credentialVersion: 'cv-sb' },
          observedAt: Date.now() - 10_000,
          items: [
            {
              label: 'Claude / GPT · 每周使用限额',
              usedPercent: 98,
              percentKind: 'remaining',
              poolId: 'agy-claude-gpt',
              resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
            },
          ],
        },
      },
    ];
    await act(async () => {
      useChatStore.setState({
        hasActiveInvocation: true,
        activeInvocations: { 'inv-live-2': 'codex61-sol' as never },
        catStatuses: { 'codex61-sol': 'streaming' },
      });
    });
    await act(async () => {
      useChatStore.setState({
        hasActiveInvocation: false,
        activeInvocations: {},
        catStatuses: { 'codex61-sol': 'done' },
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    await act(async () => {
      btn?.click();
    });
    const standbyClaudeOnlyRow = document.querySelector<HTMLElement>(
      '[data-quota-account="agy-standby-claude-only"][data-quota-role="standby"]',
    );
    expect(standbyClaudeOnlyRow).not.toBeNull();
    expect(standbyClaudeOnlyRow?.textContent).toContain('没有读数');
    expect(standbyClaudeOnlyRow?.textContent).not.toContain('剩 98%');
  });

  it('binds Kimi quota strictly per accountRef (supporting ACP Kimi cats, rejecting owner mismatch & single-account guessing) and expires relative resets via controllable now clock', () => {
    const t0 = Date.UTC(2026, 10, 16, 16, 0, 0);
    const baseKimi = {
      id: 'kimi-a',
      name: 'Kimi A',
      displayName: 'Kimi A',
      authType: 'oauth',
      clientId: 'kimi',
      builtin: false,
      kind: 'oauth',
      mode: 'subscription',
      models: [],
      hasApiKey: false,
      createdAt: '',
      updatedAt: '',
      kimiLoginReady: true,
    } as unknown as ProfileItem;

    // 1. Single unbound Kimi account (cats=[]) must NOT guess isActiveForFamily=true via kimiCount===1
    const unboundSingle = buildQuotaRingModel({
      profiles: [
        {
          ...baseKimi,
          id: 'kimi-only',
          kimiQuota: {
            owner: { accountRef: 'kimi-only', credentialVersion: 'cv-only' },
            observedAt: t0,
            items: [
              {
                label: '每周使用限额',
                usedPercent: 25,
                percentKind: 'used',
                poolId: 'kimi-weekly',
                resetsAt: new Date(t0 + 86_400_000).toISOString(),
              },
            ],
          },
        } as unknown as ProfileItem,
      ],
      cats: [],
      selectedAccountRefs: null,
      now: t0 + 10_000,
      language: 'zh',
    });
    expect(unboundSingle.allEntries[0]?.isActiveForFamily).toBe(false);
    expect(unboundSingle.summary.bars.find((b) => b.family === 'kimi')?.remainingPercent).toBeNull();

    // 2. ACP Kimi cat bound to kimi-b ignores kimi-a's reading AND expires a 1m relative reset once now >= observedAt + 60s
    const profiles = [
      {
        ...baseKimi,
        id: 'kimi-a',
        displayName: 'Kimi 主号 A',
        kimiQuota: {
          owner: { accountRef: 'kimi-a', credentialVersion: 'cv-a' },
          observedAt: t0,
          items: [
            {
              label: '每周使用限额',
              usedPercent: 95,
              percentKind: 'used',
              poolId: 'kimi-weekly',
              resetsAt: new Date(t0 + 86_400_000).toISOString(),
            },
          ],
        },
      } as unknown as ProfileItem,
      {
        ...baseKimi,
        id: 'kimi-b',
        displayName: 'Kimi 二号 B',
        kimiQuota: {
          owner: { accountRef: 'kimi-b', credentialVersion: 'cv-b' },
          observedAt: t0,
          items: [
            {
              label: '5小时使用限额',
              usedPercent: 99,
              percentKind: 'used',
              poolId: 'kimi-rate-limit',
              resetsText: 'Resets in 1m',
              // Intentionally omit resetsAt to also prove fallback relative reset anchors strictly to observedAt (never now)
            },
          ],
        },
      } as unknown as ProfileItem,
      {
        ...baseKimi,
        id: 'kimi-spoof',
        displayName: 'Kimi 错绑号',
        kimiQuota: {
          owner: { accountRef: 'kimi-a', credentialVersion: 'cv-a' },
          observedAt: t0,
          items: [{ label: '每周使用限额', usedPercent: 50, percentKind: 'used', poolId: 'kimi-weekly' }],
        },
      } as unknown as ProfileItem,
    ];
    const acpKimiCats = [
      {
        id: 'kimi31-pro',
        name: 'Kimi',
        displayName: '梵花猫',
        nickname: '墨墨',
        clientId: 'kimi',
        carrier: 'acp' as const,
        acp: { command: 'kimi', startupArgs: ['acp'] },
        accountRef: 'kimi-b',
        color: { primary: '#C27A3A', secondary: '#C27A3A' },
        mentionPatterns: ['@kimi31-pro'],
        defaultModel: 'kimi-code/k3.1-pro',
        avatar: '',
        roleDescription: '',
        personality: '',
        roster: { family: 'turkish-van', roles: [], lead: false, available: true, evaluation: '' },
      },
    ];

    // At t0 + 30s (before 1m reset): kimi-b is active at 1% (low=true); kimi-a (5%) is standby; kimi-spoof has 0 windows
    const beforeExpiry = buildQuotaRingModel({
      profiles,
      cats: acpKimiCats,
      selectedAccountRefs: null,
      now: t0 + 30_000,
      language: 'zh',
    });
    expect(beforeExpiry.allEntries.find((e) => e.id === 'kimi-b')?.isActiveForFamily).toBe(true);
    expect(beforeExpiry.allEntries.find((e) => e.id === 'kimi-a')?.isActiveForFamily).toBe(false);
    expect(beforeExpiry.allEntries.find((e) => e.id === 'kimi-spoof')?.windows).toHaveLength(0);
    expect(beforeExpiry.summary.bars.find((b) => b.family === 'kimi')).toEqual({
      family: 'kimi',
      remainingPercent: 1,
      low: true,
      exhausted: false,
    });

    // At t0 + 120s (after 1m reset): kimi-b's 1% window is elapsed=true & stale=true and exits the Kimi bar!
    const afterExpiry = buildQuotaRingModel({
      profiles,
      cats: acpKimiCats,
      selectedAccountRefs: null,
      now: t0 + 120_000,
      language: 'zh',
    });
    const kimiBWindow = afterExpiry.allEntries.find((e) => e.id === 'kimi-b')?.windows[0];
    expect(kimiBWindow?.elapsed).toBe(true);
    expect(kimiBWindow?.stale).toBe(true);
    expect(afterExpiry.summary.bars.find((b) => b.family === 'kimi')).toEqual({
      family: 'kimi',
      remainingPercent: null,
      low: false,
      exhausted: false,
    });

    // 3. Kimi Code 2.5.3 literal "reset" / "Resets in 0s" hints are treated as already elapsed immediately (bar shows Weekly 60%, never 5h 1%)
    const literalResetModel = buildQuotaRingModel({
      profiles: [
        {
          ...baseKimi,
          id: 'kimi-b',
          displayName: 'Kimi 二号 B',
          kimiQuota: {
            owner: { accountRef: 'kimi-b', credentialVersion: 'cv-b' },
            observedAt: t0,
            items: [
              {
                label: '5小时使用限额',
                usedPercent: 99,
                percentKind: 'used',
                poolId: 'kimi-rate-limit',
                resetsText: 'Reset',
                resetsAt: new Date(t0).toISOString(),
              },
              {
                label: '5小时使用限额',
                usedPercent: 98,
                percentKind: 'used',
                poolId: 'kimi-rate-limit',
                resetsText: 'reset',
              },
              {
                label: '每周使用限额',
                usedPercent: 40,
                percentKind: 'used',
                poolId: 'kimi-weekly',
                resetsText: 'Resets in 2d',
                resetsAt: new Date(t0 + 2 * 86_400_000).toISOString(),
              },
            ],
          },
        } as unknown as ProfileItem,
      ],
      cats: acpKimiCats,
      selectedAccountRefs: null,
      now: t0,
      language: 'zh',
    });
    const resetWindows = literalResetModel.allEntries[0]?.windows ?? [];
    expect(resetWindows[0]?.elapsed).toBe(true);
    expect(resetWindows[0]?.stale).toBe(true);
    expect(resetWindows[1]?.elapsed).toBe(true);
    expect(resetWindows[1]?.stale).toBe(true);
    expect(resetWindows[2]?.elapsed).toBe(false);
    expect(literalResetModel.summary.bars.find((b) => b.family === 'kimi')).toEqual({
      family: 'kimi',
      remainingPercent: 60,
      low: false,
      exhausted: false,
    });
  });

  it('draws all 4 empty slots when selected accounts have no readings, allows unpinning, and re-enables from HubAccountsTab', async () => {
    apiMock.pinPref = { pinned: true, selectedAccountRefs: ['agy-1'] };
    await act(async () => {
      root.render(
        <div>
          <QuotaRingButton onOpenAccounts={() => nav.push('/settings?s=accounts')} />
          <HubAccountsTab />
        </div>,
      );
    });

    const btn = host.querySelector<HTMLButtonElement>('[data-testid="quota-ring-button"]');
    expect(btn?.querySelector('[data-has-reading="false"]')).not.toBeNull();
    const states = [...(btn?.querySelectorAll('[data-bar-family]') ?? [])].map((b) => b.getAttribute('data-bar-state'));
    expect(states).toEqual(['empty', 'empty', 'empty', 'empty']);

    await act(async () => {
      btn?.click();
    });
    const unpinBtn = document.querySelector<HTMLButtonElement>('[data-testid="quota-ring-unpin"]');
    await act(async () => {
      unpinBtn?.click();
    });
    expect(apiMock.pinPref.pinned).toBe(false);
    expect(host.querySelector('[data-testid="quota-ring-button"]')).toBeNull();

    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="accounts-quota-pin-toggle"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      toggle?.click();
    });
    expect(apiMock.pinPref.pinned).toBe(true);
    expect(host.querySelector('[data-testid="quota-ring-button"]')).not.toBeNull();
  });

  it('excludes standby accounts and elapsed windows from bar summary, and includes activeMemberCount>0 accounts when selection is mixed', () => {
    const now = Date.now();
    const baseCodex = apiMock.accounts[0] as unknown as ProfileItem;
    const baseClaude = apiMock.accounts[2] as unknown as ProfileItem;

    const model = buildQuotaRingModel({
      profiles: [
        {
          ...baseCodex,
          id: 'codex-pro',
          quota: {
            owner: { accountRef: 'codex-pro', userId: 'u-1', workspaceId: 'ws-1' },
            observedAt: now - 60_000,
            status: 'ok',
            source: 'codex_official_readonly',
            items: [
              {
                label: '5小时使用限额',
                usedPercent: 100,
                percentKind: 'used',
                poolId: 'codex-5h',
                // Already elapsed in the past -> must NOT turn bar red!
                resetsAt: new Date(now - 60_000).toISOString(),
              },
              {
                label: '每周使用限额',
                usedPercent: 20,
                percentKind: 'used',
                poolId: 'codex-main',
                resetsAt: new Date(now + 86_400_000).toISOString(),
              },
            ],
          },
        },
        {
          ...baseCodex,
          id: 'codex-backup',
          displayName: 'Codex 备用号',
          codex: {
            kind: 'managed',
            layoutVersion: 1,
            credentialHome: '/tmp/codex-bak',
            stateRoot: '/tmp/state',
            sqliteHome: '/tmp/sqlite',
            prepared: true,
            status: 'ready',
            identity: { userId: 'u-2', workspaceId: 'ws-2', planType: 'plus' },
          },
          quota: {
            owner: { accountRef: 'codex-backup', userId: 'u-2', workspaceId: 'ws-2' },
            observedAt: now - 60_000,
            status: 'ok',
            source: 'codex_official_readonly',
            items: [
              {
                label: '每周使用限额',
                usedPercent: 98,
                percentKind: 'used',
                poolId: 'codex-main',
                resetsAt: new Date(now + 86_400_000).toISOString(),
              },
            ],
          },
        },
        {
          ...baseClaude,
          id: 'claude-a',
          builtin: false,
          claude: { kind: 'long_lived_token' },
          claudeTokenStatus: 'saved',
          claudeQuota: {
            samples: {
              'claude-opus-5-5': {
                observedAt: now - 30_000,
                windows: {
                  seven_day: { utilization: 0.35, resetsAt: Math.floor((now + 86_400_000) / 1000), status: 'allowed' },
                },
              },
            },
          },
        },
        {
          ...baseClaude,
          id: 'claude-b',
          builtin: false,
          claude: { kind: 'long_lived_token' },
          claudeTokenStatus: 'saved',
          claudeQuota: {
            samples: {
              'claude-sonnet-5-5': {
                observedAt: now - 30_000,
                windows: {
                  seven_day: { utilization: 0.86, resetsAt: Math.floor((now + 86_400_000) / 1000), status: 'allowed' },
                },
              },
            },
          },
        },
        {
          ...baseClaude,
          id: 'claude-idle',
          builtin: false,
          claude: { kind: 'long_lived_token' },
          claudeTokenStatus: 'saved',
          claudeQuota: {
            samples: {
              'claude-sonnet-5-5': {
                observedAt: now - 30_000,
                windows: {
                  seven_day: { utilization: 0.99, resetsAt: Math.floor((now + 86_400_000) / 1000), status: 'allowed' },
                },
              },
            },
          },
        },
      ],
      cats: [],
      codexSelection: { state: 'selected', accountRef: 'codex-pro', members: [] },
      claudeSelection: {
        state: 'mixed',
        members: [
          { id: 'opus55', name: 'Opus', accountRef: 'claude-a', available: true },
          { id: 'sonnet', name: 'Sonnet', accountRef: 'claude-b', available: true },
          { id: 'retired', name: 'Retired', accountRef: 'claude-idle', available: false },
        ],
      },
      selectedAccountRefs: null,
      now,
      language: 'zh',
    });

    const byFam = Object.fromEntries(model.summary.bars.map((b) => [b.family, b]));
    // Codex ignores elapsed 0% window AND ignores standby 2% account -> 80%
    expect(byFam.codex?.remainingPercent).toBe(80);
    expect(byFam.codex?.low).toBe(false);
    // Claude mixed selection checks claude-a (65%) and claude-b (14%), ignoring idle claude-idle (1%) -> 14%
    expect(byFam.claude?.remainingPercent).toBe(14);
    expect(byFam.claude?.low).toBe(true);
    expect(byFam.agy?.remainingPercent).toBeNull();
    expect(byFam.kimi?.remainingPercent).toBeNull();
  });

  it('serializes rapid account selection updates so out-of-order network responses never drop the latest choice, and rolls back to last confirmed state on failure', async () => {
    const { apiFetch } = await import('@/utils/api-client');
    const mockedFetch = vi.mocked(apiFetch);

    apiMock.pinPref = { pinned: true, selectedAccountRefs: ['init'] };
    await act(async () => {
      root.render(<QuotaRingButton onOpenAccounts={() => nav.push('/settings?s=accounts')} />);
    });
    expect(getQuotaPinStoreSnapshot().selectedAccountRefs).toEqual(['init']);

    const pendingPuts: Array<{
      body: { pinned?: boolean; selectedAccountRefs?: string[] | null };
      resolve: (res: Response) => void;
    }> = [];
    mockedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url === '/api/config/quota-pin' && method === 'PUT') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return await new Promise<Response>((resolve) => {
          pendingPuts.push({ body, resolve });
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    let p1!: Promise<boolean>;
    let p2!: Promise<boolean>;
    act(() => {
      p1 = updateQuotaPinPreference({ selectedAccountRefs: ['a'] });
      p2 = updateQuotaPinPreference({ selectedAccountRefs: ['a', 'b'] });
    });

    expect(pendingPuts).toHaveLength(1);
    expect(pendingPuts[0]?.body.selectedAccountRefs).toEqual(['a']);
    expect(getQuotaPinStoreSnapshot().selectedAccountRefs).toEqual(['a', 'b']);

    apiMock.pinPref = { pinned: true, selectedAccountRefs: pendingPuts[0]?.body.selectedAccountRefs ?? null };
    await act(async () => {
      pendingPuts[0]?.resolve(
        new Response(JSON.stringify(apiMock.pinPref), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    });
    await vi.waitFor(() => expect(pendingPuts).toHaveLength(2));
    expect(pendingPuts[1]?.body.selectedAccountRefs).toEqual(['a', 'b']);

    apiMock.pinPref = { pinned: true, selectedAccountRefs: pendingPuts[1]?.body.selectedAccountRefs ?? null };
    await act(async () => {
      pendingPuts[1]?.resolve(
        new Response(JSON.stringify(apiMock.pinPref), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      await Promise.all([p1, p2]);
    });

    expect(apiMock.pinPref.selectedAccountRefs).toEqual(['a', 'b']);
    expect(getQuotaPinStoreSnapshot().selectedAccountRefs).toEqual(['a', 'b']);
    expect(getQuotaPinStoreSnapshot().saving).toBe(false);

    let f1!: Promise<boolean>;
    let f2!: Promise<boolean>;
    act(() => {
      f1 = updateQuotaPinPreference({ selectedAccountRefs: ['x'] });
      f2 = updateQuotaPinPreference({ selectedAccountRefs: ['x', 'y'] });
    });
    await vi.waitFor(() => expect(pendingPuts).toHaveLength(3));
    await act(async () => {
      pendingPuts[2]?.resolve(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
    });
    await vi.waitFor(() => expect(pendingPuts).toHaveLength(4));
    let ok1 = true;
    let ok2 = true;
    await act(async () => {
      pendingPuts[3]?.resolve(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
      [ok1, ok2] = await Promise.all([f1, f2]);
    });
    expect(ok1).toBe(false);
    expect(ok2).toBe(false);
    expect(getQuotaPinStoreSnapshot().selectedAccountRefs).toEqual(['a', 'b']);
    expect(getQuotaPinStoreSnapshot().error).toBe(true);
    expect(getQuotaPinStoreSnapshot().saving).toBe(false);
  });
});
