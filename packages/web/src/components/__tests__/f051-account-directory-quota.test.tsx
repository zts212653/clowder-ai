import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { CliAccountQuotaControl } from '../accounts/CliAccountQuotaControl';
import { AccountRequestError } from '../codex-accounts/account-request';
import { HubAccountsTab } from '../HubAccountsTab';
import type { AccountSelection, ProfileItem } from '../hub-accounts.types';
import { QuotaRingButton } from '../shell/QuotaRingButton';

const FIXED_NOW = 1794952600000; // 2026-11-17T21:56:40Z (shortly after runtime sample 1794952538821)

const mockState = vi.hoisted(() => ({
  cats: [] as CatData[],
  accounts: [] as ProfileItem[],
  codexSelection: { state: 'empty', members: [] } as AccountSelection,
  claudeSelection: { state: 'empty', members: [] } as AccountSelection,
  agySelection: { state: 'empty', members: [] } as AccountSelection,
  pinPref: { pinned: true, selectedAccountRefs: null as string[] | null },
  calls: [] as Array<{ url: string; method: string; body?: unknown }>,
  postQuotaHandler: null as null | ((url: string) => Promise<Response>),
}));

function selectionResponseForUrl(url: string): Response | null {
  if (url.startsWith('/api/accounts/codex/members')) {
    return Response.json({ selection: mockState.codexSelection, members: mockState.codexSelection.members });
  }
  if (url.startsWith('/api/accounts/claude/members')) {
    return Response.json({ selection: mockState.claudeSelection, members: mockState.claudeSelection.members });
  }
  if (url.startsWith('/api/accounts/agy/members')) {
    return Response.json({ selection: mockState.agySelection, members: mockState.agySelection.members });
  }
  return null;
}

async function handleMockApiFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = String(path);
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : undefined;
  mockState.calls.push({ url, method, body });

  if (url === '/api/config/quota-pin') {
    if (method === 'PUT' && body && typeof body === 'object') {
      mockState.pinPref = { ...mockState.pinPref, ...(body as Partial<typeof mockState.pinPref>) };
    }
    return Response.json(mockState.pinPref);
  }
  const selectionRes = selectionResponseForUrl(url);
  if (selectionRes) return selectionRes;

  if (method === 'POST' && /\/api\/accounts\/[^/]+\/(?:agy|kimi)\/quota$/.test(url) && mockState.postQuotaHandler) {
    return mockState.postQuotaHandler(url);
  }
  if (method === 'POST' && url.endsWith('/agy/binding/preview')) {
    return Response.json({
      previewToken: 'c'.repeat(64),
      accountRef: 'gemini',
      targets: [{ catId: 'gemini-carbon', name: '碳碳', previousAccountRef: 'agy-backup' }],
      exceptions: [],
    });
  }
  return Response.json({ projectPath: '/fixture', providers: mockState.accounts });
}

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: mockState.cats, loading: false }),
}));

vi.mock('../useConfirm', () => ({ useConfirm: () => async () => true }));

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn((path: string, init?: RequestInit) => handleMockApiFetch(path, init)),
}));

function requireEl<T extends Element>(parent: ParentNode, selector: string): T {
  const el = parent.querySelector<T>(selector);
  if (!el) throw new Error(`Expected element matching ${selector}`);
  return el;
}

function requireButtonByText(parent: ParentNode, label: string, exact = false): HTMLButtonElement {
  const btn = [...parent.querySelectorAll('button')].find((b) =>
    exact ? b.textContent === label : Boolean(b.textContent?.includes(label)),
  );
  if (!btn) throw new Error(`Expected button matching "${label}"`);
  return btn;
}

describe('F051 /settings?s=accounts AGY & Kimi directory parity and ownership boundaries', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    mockState.calls = [];
    mockState.postQuotaHandler = null;
    mockState.pinPref = { pinned: true, selectedAccountRefs: null };
    mockState.cats = [
      {
        id: 'gemini-carbon',
        name: '暹罗猫',
        displayName: '暹罗猫',
        nickname: '碳碳',
        color: { primary: '#2563eb', secondary: '#93c5fd' },
        mentionPatterns: ['@gemini-carbon'],
        clientId: 'google',
        carrier: 'cli',
        defaultModel: 'gemini-4-carbon-high',
        cli: { command: 'agy' },
        agyProfile: {
          enabled: true,
          carrier: 'native',
          profileId: 'gemini-argon',
          model: 'gemini-4-carbon-high',
          autoApprove: true,
          trustedWorkspaces: [],
        },
        roster: { available: true },
      } as unknown as CatData,
      {
        id: 'kimi31-pro',
        name: '梵花猫',
        displayName: '梵花猫',
        nickname: '墨墨',
        color: { primary: '#d97706', secondary: '#fcd34d' },
        mentionPatterns: ['@kimi31-pro'],
        clientId: 'kimi',
        accountRef: 'kimi-code-native',
        carrier: 'acp',
        defaultModel: 'kimi-code/k3.1-pro',
        acp: { command: 'kimi', startupArgs: ['acp'] },
        roster: { available: true },
      } as unknown as CatData,
    ];
    mockState.codexSelection = { state: 'empty', members: [] };
    mockState.claudeSelection = { state: 'empty', members: [] };
    mockState.agySelection = {
      state: 'consensus',
      accountRef: 'gemini',
      members: [
        {
          id: 'gemini-carbon',
          name: '碳碳',
          avatar: '/avatars/gemini.png',
          accountRef: 'gemini',
          available: true,
          bindingMode: 'follow',
        },
      ],
    };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.querySelector('[data-testid="quota-ring-popover"]')?.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders identical AGY dual-pool and Kimi meters in /settings?s=accounts and sidebar QuotaRingPopover, and syncs manual refresh', async () => {
    mockState.accounts = [
      {
        id: 'gemini',
        name: 'Gemini (OAuth)',
        displayName: 'Gemini (OAuth)',
        authType: 'oauth',
        kind: 'builtin',
        builtin: true,
        clientId: 'google',
        mode: 'subscription',
        hasApiKey: false,
        createdAt: '',
        updatedAt: '',
        agyQuotaReady: true,
        agyQuota: {
          owner: { accountRef: 'gemini', credentialVersion: 'cv-gemini-live' },
          observedAt: 1794952538821,
          items: [
            {
              label: 'Gemini · 每周使用限额',
              usedPercent: 34.98,
              percentKind: 'remaining',
              poolId: 'agy-gemini',
              resetsAt: '2026-11-20T23:28:16Z',
            },
            {
              label: 'Gemini · 5小时使用限额',
              usedPercent: 97.65,
              percentKind: 'remaining',
              poolId: 'agy-gemini',
              resetsAt: '2026-11-18T01:15:19Z',
            },
            {
              label: 'Claude / GPT · 每周使用限额',
              usedPercent: 97.97,
              percentKind: 'remaining',
              poolId: 'agy-claude-gpt',
              resetsAt: '2026-11-20T03:25:36Z',
            },
            {
              label: 'Claude / GPT · 5小时使用限额',
              usedPercent: 100,
              percentKind: 'remaining',
              poolId: 'agy-claude-gpt',
              resetsAt: '2026-11-18T02:55:38Z',
            },
          ],
        },
      },
      {
        id: 'kimi-code-native',
        name: 'Kimi Code Native',
        displayName: 'Kimi Code Native',
        authType: 'oauth',
        kind: 'builtin',
        builtin: true,
        clientId: 'kimi',
        mode: 'subscription',
        hasApiKey: false,
        createdAt: '',
        updatedAt: '',
        kimiLoginReady: true,
        kimiQuota: {
          owner: { accountRef: 'kimi-code-native', credentialVersion: 'cv-kimi-live' },
          observedAt: 1794952538023,
          items: [
            {
              label: '5小时使用限额',
              usedPercent: 0,
              percentKind: 'used',
              poolId: 'kimi-rate-limit',
              resetsAt: '2026-11-18T01:39:38.023Z',
              resetsText: 'Resets in 3h 44m',
            },
            {
              label: '每周使用限额',
              usedPercent: 60,
              percentKind: 'used',
              poolId: 'kimi-weekly',
              resetsAt: '2026-11-20T14:39:38.023Z',
              resetsText: 'Resets in 2d 16h 44m',
            },
          ],
        },
      },
    ];

    await act(async () =>
      root.render(
        <div>
          <QuotaRingButton onOpenAccounts={() => {}} />
          <HubAccountsTab />
        </div>,
      ),
    );

    const ringBtn = requireEl<HTMLButtonElement>(host, '[data-testid="quota-ring-button"]');
    await act(async () => ringBtn.click());

    const popover = requireEl<HTMLElement>(document, '[data-testid="quota-ring-popover"]');
    const geminiRow = requireEl<HTMLElement>(host, '[data-account-id="gemini"]');
    const kimiRow = requireEl<HTMLElement>(host, '[data-account-id="kimi-code-native"]');

    // Neither row may show false "读不到" or "这一家没有额度接口"
    expect(geminiRow.textContent).toContain('已登录');
    expect(geminiRow.textContent).not.toContain('读不到');
    expect(geminiRow.textContent).not.toContain('这一家没有额度接口');
    expect(geminiRow.textContent).toContain('Gemini · 本周');
    expect(geminiRow.textContent).toContain('Claude / GPT · 本周');

    // Dual-pool tightest preservation: one tightest window per AGY pool (2 total across 4 windows)
    expect(geminiRow.querySelectorAll('.account-quota-window[data-tightest="true"]')).toHaveLength(2);

    expect(kimiRow.textContent).toContain('已登录');
    expect(kimiRow.textContent).not.toContain('读不到');
    expect(kimiRow.textContent).not.toContain('这一家没有额度接口');
    expect(kimiRow.textContent).toContain('正在用');
    expect(kimiRow.textContent).toContain('1 只猫');

    const rowMeterValues = (row: Element) =>
      [...row.querySelectorAll('[role="meter"]')].map((el) => el.getAttribute('aria-valuenow'));
    const cardMeterValues = (accountId: string) =>
      [...(popover.querySelector(`[data-quota-account="${accountId}"]`)?.querySelectorAll('[role="meter"]') ?? [])].map(
        (el) => el.getAttribute('aria-valuenow'),
      );

    expect(rowMeterValues(geminiRow)).toEqual(['35', '98', '98', '100']);
    expect(rowMeterValues(geminiRow)).toEqual(cardMeterValues('gemini'));

    expect(rowMeterValues(kimiRow)).toEqual(['100', '40']);
    expect(rowMeterValues(kimiRow)).toEqual(cardMeterValues('kimi-code-native'));

    // Refreshing Gemini inside /settings?s=accounts updates BOTH the row AND the sidebar popover
    mockState.postQuotaHandler = async (url) => {
      expect(url).toBe('/api/accounts/gemini/agy/quota');
      const updatedAgyQuota = {
        owner: { accountRef: 'gemini', credentialVersion: 'cv-gemini-live' },
        observedAt: FIXED_NOW,
        items: [
          {
            label: 'Gemini · 每周使用限额',
            usedPercent: 28.4,
            percentKind: 'remaining' as const,
            poolId: 'agy-gemini',
            resetsAt: '2026-11-20T23:28:16Z',
          },
          {
            label: 'Claude / GPT · 每周使用限额',
            usedPercent: 91.2,
            percentKind: 'remaining' as const,
            poolId: 'agy-claude-gpt',
            resetsAt: '2026-11-20T03:25:36Z',
          },
        ],
      };
      mockState.accounts = mockState.accounts.map((acc) =>
        acc.id === 'gemini' ? { ...acc, agyQuota: updatedAgyQuota } : acc,
      );
      return Response.json({ accountRef: 'gemini', agyQuota: updatedAgyQuota });
    };

    const geminiRefreshBtn = requireEl<HTMLButtonElement>(geminiRow, 'button[aria-label="刷新额度"]');
    await act(async () => geminiRefreshBtn.click());

    expect(rowMeterValues(requireEl(host, '[data-account-id="gemini"]'))).toEqual(['28', '91']);
    expect(cardMeterValues('gemini')).toEqual(['28', '91']);
  });

  it('covers managed AGY, ready-without-reading, unverified/conflicting ownership, 409 & owner-unknown errors, non-AGY Google isolation, and gemini switch-back', async () => {
    mockState.cats = []; // No active Kimi cats -> kimi-code-native is unused, must STILL NOT offer broken switch button!
    mockState.agySelection = {
      state: 'selected',
      accountRef: 'agy-backup',
      members: [
        {
          id: 'gemini-carbon',
          name: '碳碳',
          accountRef: 'agy-backup',
          available: true,
          bindingMode: 'follow',
        },
      ],
    };
    mockState.accounts = [
      // 1. Ready builtin gemini with NO reading yet + unused (allows Check quota AND switch-back to /agy/binding/preview)
      {
        id: 'gemini',
        name: 'Gemini (OAuth)',
        displayName: 'Gemini (OAuth)',
        authType: 'oauth',
        kind: 'builtin',
        builtin: true,
        clientId: 'google',
        mode: 'subscription',
        hasApiKey: false,
        createdAt: '',
        updatedAt: '',
        agyQuotaReady: true,
      },
      // 2. Managed AGY profile in active use with verified reading
      {
        id: 'agy-backup',
        name: '暹罗备用号',
        displayName: '暹罗备用号',
        authType: 'oauth',
        kind: 'oauth',
        builtin: false,
        clientId: 'google',
        mode: 'subscription',
        hasApiKey: false,
        createdAt: '',
        updatedAt: '',
        agy: { storage: 'cli_file', credentialHome: '/fixture/agy-backup' },
        agyLoginStatus: 'ready',
        agyQuotaReady: true,
        agyQuota: {
          owner: { accountRef: 'agy-backup', credentialVersion: 'cv-backup' },
          observedAt: FIXED_NOW,
          items: [
            { label: 'Gemini · 每周使用限额', usedPercent: 64, percentKind: 'remaining', poolId: 'agy-gemini' },
            {
              label: 'Claude / GPT · 每周使用限额',
              usedPercent: 72,
              percentKind: 'remaining',
              poolId: 'agy-claude-gpt',
            },
          ],
        },
      },
      // 3. Managed AGY with unverified/conflicting ownership (agyQuotaReady=false) + leaked foreign owner observation -> must hide reading!
      {
        id: 'agy-conflict',
        name: '冲突号',
        displayName: '冲突号',
        authType: 'oauth',
        kind: 'oauth',
        builtin: false,
        clientId: 'google',
        mode: 'subscription',
        hasApiKey: false,
        createdAt: '',
        updatedAt: '',
        agy: { storage: 'cli_file', credentialHome: '/fixture/agy-conflict' },
        agyLoginStatus: 'unreadable',
        agyQuotaReady: false,
        agyQuota: {
          owner: { accountRef: 'agy-conflict', credentialVersion: 'stale-cv' },
          observedAt: FIXED_NOW,
          items: [{ label: 'Gemini · 每周使用限额', usedPercent: 80, percentKind: 'remaining', poolId: 'agy-gemini' }],
        },
      },
      // 4. Ready Kimi with mismatched owner.accountRef -> rejects mismatched reading, shows Check quota, and NO "换成这个"
      {
        id: 'kimi-code-native',
        name: 'Kimi Code Native',
        displayName: 'Kimi Code Native',
        authType: 'oauth',
        kind: 'builtin',
        builtin: true,
        clientId: 'kimi',
        mode: 'subscription',
        hasApiKey: false,
        createdAt: '',
        updatedAt: '',
        kimiLoginReady: true,
        kimiQuota: {
          owner: { accountRef: 'other-kimi', credentialVersion: 'cv-other' },
          observedAt: FIXED_NOW,
          items: [{ label: '每周使用限额', usedPercent: 10, percentKind: 'used', poolId: 'kimi-weekly' }],
        },
      },
      // 5. Unlogged Kimi -> "没登录" + "这个号查不了额度。"
      {
        id: 'kimi-unlogged',
        name: 'Kimi 备用',
        displayName: 'Kimi 备用',
        authType: 'oauth',
        kind: 'oauth',
        builtin: false,
        clientId: 'kimi',
        mode: 'subscription',
        hasApiKey: false,
        createdAt: '',
        updatedAt: '',
        kimiLoginReady: false,
      },
      // 6. Google Cloud Vertex AI OAuth -> NEVER treated as AGY!
      {
        id: 'google-cloud-vertex',
        name: 'Vertex',
        displayName: 'Vertex',
        authType: 'oauth',
        kind: 'oauth',
        builtin: false,
        clientId: 'google',
        mode: 'subscription',
        hasApiKey: false,
        createdAt: '',
        updatedAt: '',
        googleCloud: { credential: 'local_adc', projectId: 'household-proj-1' },
      },
      // 7. Google API Key -> NEVER treated as AGY!
      {
        id: 'google-api-key',
        name: 'Google API Key',
        displayName: 'Google API Key',
        authType: 'api_key',
        kind: 'api_key',
        builtin: false,
        clientId: 'google',
        mode: 'api_key',
        hasApiKey: true,
        createdAt: '',
        updatedAt: '',
      },
    ];

    await act(async () => root.render(<HubAccountsTab />));

    const row = (id: string) => requireEl<HTMLElement>(host, `[data-account-id="${id}"]`);

    // 1. Ready gemini with no reading yet: zero fake 0% meter, shows Check quota button
    expect(row('gemini').querySelectorAll('[role="meter"]')).toHaveLength(0);
    expect(row('gemini').textContent).toContain('已登录');
    expect(row('gemini').textContent).toContain('尚无可确认的读数');
    const checkGeminiBtn = requireButtonByText(row('gemini'), '查额度');

    // Simulate 409 credential rotation on manual query
    mockState.postQuotaHandler = async () => {
      throw new AccountRequestError('agy_quota_credential_changed', 409);
    };
    await act(async () => checkGeminiBtn.click());
    expect(row('gemini').textContent).toContain('此号的登录已变化，请刷新账号列表后重试');

    // Switch-back button on builtin gemini hits /api/accounts/gemini/agy/binding/preview (NOT /codex/binding/preview)
    const switchGeminiBtn = requireButtonByText(row('gemini'), '换成这个', true);
    await act(async () => switchGeminiBtn.click());
    expect(mockState.calls.some((c) => c.url === '/api/accounts/gemini/agy/binding/preview')).toBe(true);
    expect(mockState.calls.some((c) => c.url.includes('/codex/binding/preview'))).toBe(false);

    // 2. Managed AGY profile in active use: renders Google · AGY + 登录文件已就绪 + 2 separated pool meters
    expect(row('agy-backup').textContent).toContain('Google · AGY');
    expect(row('agy-backup').textContent).toContain('登录文件已就绪');
    expect(
      [...row('agy-backup').querySelectorAll('[role="meter"]')].map((m) => m.getAttribute('aria-valuenow')),
    ).toEqual(['64', '72']);

    // 3. Conflict/unreadable AGY row: zero meters, no query button
    expect(row('agy-conflict').querySelectorAll('[role="meter"]')).toHaveLength(0);
    expect(row('agy-conflict').textContent).toContain('读不到');
    expect(row('agy-conflict').textContent).toContain('这个号查不了额度');

    // 4. Kimi with mismatched owner: zero leaked meters, no "换成这个" button, handles owner_unknown error honestly
    expect(row('kimi-code-native').querySelectorAll('[role="meter"]')).toHaveLength(0);
    expect(row('kimi-code-native').textContent).toContain('尚无可确认的读数');
    expect([...row('kimi-code-native').querySelectorAll('button')].some((b) => b.textContent === '换成这个')).toBe(
      false,
    );
    mockState.postQuotaHandler = async () => {
      throw new AccountRequestError('kimi_quota_owner_unknown', 422);
    };
    const checkKimiBtn = requireButtonByText(row('kimi-code-native'), '查额度');
    await act(async () => checkKimiBtn.click());
    expect(row('kimi-code-native').textContent).toContain('无法确认此号的登录，请先核对登录状态');

    // 5. Unlogged Kimi: "没登录" + "这个号查不了额度"
    expect(row('kimi-unlogged').textContent).toContain('没登录');
    expect(row('kimi-unlogged').textContent).toContain('这个号查不了额度');

    // 6 & 7. Google Cloud Vertex AI and Google API Key are NOT treated as AGY
    expect(row('google-cloud-vertex').querySelectorAll('[role="meter"]')).toHaveLength(0);
    expect(row('google-cloud-vertex').textContent).toContain('这一家没有额度接口');
    expect([...row('google-cloud-vertex').querySelectorAll('button')].some((b) => b.textContent === '换成这个')).toBe(
      false,
    );

    expect(row('google-api-key').querySelectorAll('[role="meter"]')).toHaveLength(0);
    expect(row('google-api-key').textContent).toContain('密钥已填');
    expect(row('google-api-key').textContent).toContain('余额请到服务商那里看');
  });

  it('P1-1: discards late responses and errors from superseded in-flight refreshes on both AGY and Kimi even when reload() fails', async () => {
    let resolveAgyStale: ((res: Response) => void) | undefined;
    let resolveKimiStale: ((res: Response) => void) | undefined;
    let rejectAgySuperseded: ((err: Error) => void) | undefined;

    mockState.postQuotaHandler = (url) => {
      if (url.endsWith('/agy/quota')) {
        if (!resolveAgyStale) {
          return new Promise<Response>((resolve) => {
            resolveAgyStale = resolve;
          });
        }
        return new Promise<Response>((_resolve, reject) => {
          rejectAgySuperseded = reject;
        });
      }
      return new Promise<Response>((resolve) => {
        resolveKimiStale = resolve;
      });
    };

    const failingReload = vi.fn(async () => {
      throw new Error('reload_network_failed');
    });

    const agyCvA: ProfileItem = {
      id: 'gemini',
      name: 'Gemini (OAuth)',
      displayName: 'Gemini (OAuth)',
      authType: 'oauth',
      kind: 'builtin',
      builtin: true,
      clientId: 'google',
      mode: 'subscription',
      hasApiKey: false,
      createdAt: '',
      updatedAt: '',
      agyQuotaReady: true,
      agyQuota: {
        owner: { accountRef: 'gemini', credentialVersion: 'cv-A' },
        observedAt: FIXED_NOW - 10_000,
        items: [{ label: 'Gemini · 每周使用限额', usedPercent: 25, percentKind: 'remaining', poolId: 'agy-gemini' }],
      },
    };
    const kimiCvA: ProfileItem = {
      id: 'kimi-code-native',
      name: 'Kimi Code Native',
      displayName: 'Kimi Code Native',
      authType: 'oauth',
      kind: 'oauth',
      builtin: false,
      clientId: 'kimi',
      mode: 'subscription',
      hasApiKey: false,
      createdAt: '',
      updatedAt: '',
      kimiLoginReady: true,
      kimiQuota: {
        owner: { accountRef: 'kimi-code-native', credentialVersion: 'cv-A' },
        observedAt: FIXED_NOW - 10_000,
        items: [{ label: '每周使用限额', usedPercent: 75, percentKind: 'used', poolId: 'kimi-weekly' }],
      },
    };

    const renderBoth = (agyAcc: ProfileItem, kimiAcc: ProfileItem) =>
      root.render(
        <div>
          <div data-testid="agy-box">
            <CliAccountQuotaControl kind="agy" account={agyAcc} reload={failingReload} />
          </div>
          <div data-testid="kimi-box">
            <CliAccountQuotaControl kind="kimi" account={kimiAcc} reload={failingReload} />
          </div>
        </div>,
      );

    await act(async () => renderBoth(agyCvA, kimiCvA));

    const agyBox = requireEl<HTMLElement>(host, '[data-testid="agy-box"]');
    const kimiBox = requireEl<HTMLElement>(host, '[data-testid="kimi-box"]');
    expect(requireEl(agyBox, '[role="meter"]').getAttribute('aria-valuenow')).toBe('25');
    expect(requireEl(kimiBox, '[role="meter"]').getAttribute('aria-valuenow')).toBe('25');

    // Start in-flight refresh on both cv-A controls and hold responses
    await act(async () => {
      requireEl<HTMLButtonElement>(agyBox, 'button[aria-label="刷新额度"]').click();
      requireEl<HTMLButtonElement>(kimiBox, 'button[aria-label="刷新额度"]').click();
    });

    // Advance parent props to cv-B (95% remaining) while cv-A requests are still in flight
    const agyCvB: ProfileItem = {
      ...agyCvA,
      agyQuota: {
        owner: { accountRef: 'gemini', credentialVersion: 'cv-B' },
        observedAt: FIXED_NOW,
        items: [{ label: 'Gemini · 每周使用限额', usedPercent: 95, percentKind: 'remaining', poolId: 'agy-gemini' }],
      },
    };
    const kimiCvB: ProfileItem = {
      ...kimiCvA,
      kimiQuota: {
        owner: { accountRef: 'kimi-code-native', credentialVersion: 'cv-B' },
        observedAt: FIXED_NOW,
        items: [{ label: '每周使用限额', usedPercent: 5, percentKind: 'used', poolId: 'kimi-weekly' }],
      },
    };
    await act(async () => renderBoth(agyCvB, kimiCvB));
    expect(requireEl(agyBox, '[role="meter"]').getAttribute('aria-valuenow')).toBe('95');
    expect(requireEl(kimiBox, '[role="meter"]').getAttribute('aria-valuenow')).toBe('95');

    // Release late cv-A/25% responses; reload() also rejects so no new prop render can rescue stale local state
    await act(async () => {
      resolveAgyStale?.(
        Response.json({
          agyQuota: {
            owner: { accountRef: 'gemini', credentialVersion: 'cv-A' },
            observedAt: FIXED_NOW - 5_000,
            items: [
              { label: 'Gemini · 每周使用限额', usedPercent: 25, percentKind: 'remaining', poolId: 'agy-gemini' },
            ],
          },
        }),
      );
      resolveKimiStale?.(
        Response.json({
          kimiQuota: {
            owner: { accountRef: 'kimi-code-native', credentialVersion: 'cv-A' },
            observedAt: FIXED_NOW - 5_000,
            items: [{ label: '每周使用限额', usedPercent: 75, percentKind: 'used', poolId: 'kimi-weekly' }],
          },
        }),
      );
    });

    expect(requireEl(agyBox, '[role="meter"]').getAttribute('aria-valuenow')).toBe('95');
    expect(requireEl(kimiBox, '[role="meter"]').getAttribute('aria-valuenow')).toBe('95');
    expect(agyBox.querySelector('[role="alert"]')).toBeNull();
    expect(kimiBox.querySelector('[role="alert"]')).toBeNull();

    // Start another refresh on cv-B, advance props to cv-C (88%), then reject old cv-B request -> no error banner
    await act(async () => {
      requireEl<HTMLButtonElement>(agyBox, 'button[aria-label="刷新额度"]').click();
    });
    const agyCvC: ProfileItem = {
      ...agyCvB,
      agyQuota: {
        owner: { accountRef: 'gemini', credentialVersion: 'cv-C' },
        observedAt: FIXED_NOW + 1_000,
        items: [{ label: 'Gemini · 每周使用限额', usedPercent: 88, percentKind: 'remaining', poolId: 'agy-gemini' }],
      },
    };
    await act(async () => renderBoth(agyCvC, kimiCvB));
    await act(async () => {
      rejectAgySuperseded?.(new AccountRequestError('agy_quota_credential_changed', 409));
    });
    expect(requireEl(agyBox, '[role="meter"]').getAttribute('aria-valuenow')).toBe('88');
    expect(agyBox.querySelector('[role="alert"]')).toBeNull();
  });

  it('P1-2: excludes elapsed windows when selecting narrow-screen data-tightest per AGY pool and Kimi, preserves dual pools, and shifts across resetsAt boundary', async () => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    try {
      const agyMixed: ProfileItem = {
        id: 'gemini',
        name: 'Gemini (OAuth)',
        displayName: 'Gemini (OAuth)',
        authType: 'oauth',
        kind: 'builtin',
        builtin: true,
        clientId: 'google',
        mode: 'subscription',
        hasApiKey: false,
        createdAt: '',
        updatedAt: '',
        agyQuotaReady: true,
        agyQuota: {
          owner: { accountRef: 'gemini', credentialVersion: 'cv-narrow' },
          observedAt: FIXED_NOW - 30_000,
          items: [
            // Expired 1% window vs active 90% window in agy-gemini
            {
              label: 'Gemini · 5小时使用限额',
              usedPercent: 1,
              percentKind: 'remaining',
              poolId: 'agy-gemini',
              resetsAt: new Date(FIXED_NOW - 60_000).toISOString(),
            },
            {
              label: 'Gemini · 每周使用限额',
              usedPercent: 90,
              percentKind: 'remaining',
              poolId: 'agy-gemini',
              resetsAt: new Date(FIXED_NOW + 86_400_000).toISOString(),
            },
            // Soon-to-expire 5% window (+1000ms) vs active 84% window in agy-claude-gpt
            {
              label: 'Claude / GPT · 5小时使用限额',
              usedPercent: 5,
              percentKind: 'remaining',
              poolId: 'agy-claude-gpt',
              resetsAt: new Date(FIXED_NOW + 1_000).toISOString(),
            },
            {
              label: 'Claude / GPT · 每周使用限额',
              usedPercent: 84,
              percentKind: 'remaining',
              poolId: 'agy-claude-gpt',
              resetsAt: new Date(FIXED_NOW + 86_400_000).toISOString(),
            },
          ],
        },
      };

      const agyHistoricalPool: ProfileItem = {
        ...agyMixed,
        id: 'agy-historical',
        agyQuota: {
          owner: { accountRef: 'agy-historical', credentialVersion: 'cv-hist' },
          observedAt: FIXED_NOW - 30_000,
          items: [
            // agy-gemini has ONLY elapsed historical windows -> keeps pool separated with explicit elapsed copy
            {
              label: 'Gemini · 每周使用限额',
              usedPercent: 35,
              percentKind: 'remaining',
              poolId: 'agy-gemini',
              resetsAt: new Date(FIXED_NOW - 120_000).toISOString(),
            },
            // agy-claude-gpt has active 88% window
            {
              label: 'Claude / GPT · 每周使用限额',
              usedPercent: 88,
              percentKind: 'remaining',
              poolId: 'agy-claude-gpt',
              resetsAt: new Date(FIXED_NOW + 86_400_000).toISOString(),
            },
          ],
        },
      };

      const kimiMixed: ProfileItem = {
        id: 'kimi-code-native',
        name: 'Kimi Code Native',
        displayName: 'Kimi Code Native',
        authType: 'oauth',
        kind: 'oauth',
        builtin: false,
        clientId: 'kimi',
        mode: 'subscription',
        hasApiKey: false,
        createdAt: '',
        updatedAt: '',
        kimiLoginReady: true,
        kimiQuota: {
          owner: { accountRef: 'kimi-code-native', credentialVersion: 'cv-kimi-narrow' },
          observedAt: FIXED_NOW - 30_000,
          items: [
            // Expired 1% left (99% used) vs active 90% left (10% used)
            {
              label: '5小时使用限额',
              usedPercent: 99,
              percentKind: 'used',
              poolId: 'kimi-rate-limit',
              resetsAt: new Date(FIXED_NOW - 60_000).toISOString(),
            },
            {
              label: '每周使用限额',
              usedPercent: 10,
              percentKind: 'used',
              poolId: 'kimi-weekly',
              resetsAt: new Date(FIXED_NOW + 86_400_000).toISOString(),
            },
          ],
        },
      };

      const noopReload = async () => {};
      await act(async () =>
        root.render(
          <div>
            <div data-testid="agy-mixed">
              <CliAccountQuotaControl kind="agy" account={agyMixed} reload={noopReload} />
            </div>
            <div data-testid="agy-hist">
              <CliAccountQuotaControl kind="agy" account={agyHistoricalPool} reload={noopReload} />
            </div>
            <div data-testid="kimi-mixed">
              <CliAccountQuotaControl kind="kimi" account={kimiMixed} reload={noopReload} />
            </div>
          </div>,
        ),
      );

      const tightestMeters = (testId: string) =>
        [
          ...requireEl(host, `[data-testid="${testId}"]`).querySelectorAll(
            '.account-quota-window[data-tightest="true"] [role="meter"]',
          ),
        ].map((el) => el.getAttribute('aria-valuenow'));

      // At FIXED_NOW: agy-gemini excludes elapsed 1% -> selects 90%; agy-claude-gpt still active 5% -> selects 5%
      expect(tightestMeters('agy-mixed')).toEqual(['90', '5']);
      // Kimi excludes elapsed 1% -> selects active 90%
      expect(tightestMeters('kimi-mixed')).toEqual(['90']);
      // All-elapsed pool stays separated alongside active pool with explicit resetElapsed copy
      expect(tightestMeters('agy-hist')).toEqual(['35', '88']);
      const histElapsedWin = requireEl(
        host,
        '[data-testid="agy-hist"] .account-quota-window[data-tightest="true"][data-elapsed="true"]',
      );
      expect(histElapsedWin.textContent).toContain('已过重置时间');
      expect(histElapsedWin.getAttribute('data-low')).toBe('false');

      // Advance clock across agy-claude-gpt 5h resetsAt (+1_500ms) -> 5% becomes elapsed, tightest shifts to 84%!
      await act(async () => {
        vi.advanceTimersByTime(1_500);
      });
      expect(tightestMeters('agy-mixed')).toEqual(['90', '84']);
    } finally {
      vi.useRealTimers();
    }
  });
});
