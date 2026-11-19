import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

const NOW = Date.UTC(2026, 10, 16, 2, 0);
const SEC = NOW / 1000;
const selection = { accountRef: 'claude', members: [] };

function bindAccounts(
  providers: unknown[],
  post: (path: string) => Promise<unknown>,
  get: (path: string) => unknown = (path) => (path === '/api/accounts' ? { providers } : { selection }),
  cats: unknown[] = [],
) {
  let needed: (diff: { added: string[]; removed: string[] }) => void = () => {};
  let pending: Promise<unknown> = Promise.resolve();
  const context = createContext({
    S: {},
    CS: {},
    VM: {},
    A: {},
    PAGES: {},
    INPUTS: {},
    ENT: {},
    CHANGES: {},
    render: vi.fn(),
    heldNeeded: new Set(),
    projectionNeeded: null,
    settleHold: (p: Promise<unknown>) => {
      pending = p;
    },
    setTimeout,
    clearTimeout,
    chatDataRender: async () => {},
    document: { addEventListener: vi.fn(), hidden: false },
    api: {
      now: () => NOW,
      on: (_: string, fn: typeof needed) => {
        needed = fn;
      },
      get: async (path: string) => get(path),
      post: (path: string) => post(path),
    },
    chatRead: () => ({ cats }),
  });
  runInContext(`${readFileSync('public/pdl-app/accounts.js', 'utf8')}\nbindAccounts();`, context);
  const need = (key: string) => {
    needed({ added: [key], removed: [] });
    return pending;
  };
  return { context, read: () => need('accounts'), need };
}
const rows = (context: ReturnType<typeof createContext>) => runInContext('VM.accounts().login.items', context);

const builtin = {
  id: 'claude',
  displayName: 'Claude',
  clientId: 'anthropic',
  authType: 'oauth',
  builtin: true,
  claudeQuota: {
    samples: {
      'claude-haiku-4-5': {
        observedAt: NOW - 60000,
        windows: {
          five_hour: { utilization: 0.25, resetsAt: SEC + 3600 },
          seven_day: { utilization: 1, resetsAt: SEC + 86400 },
        },
      },
      'claude-fable-5-1': {
        observedAt: NOW - 30000,
        windows: {
          seven_day: { utilization: 0.5, resetsAt: SEC + 86400 },
          seven_day_overage_included: { utilization: 0.9, resetsAt: SEC + 86400 },
          seven_day_opus: { utilization: 0.4 },
        },
      },
    },
  },
};

it('maps a Claude OAuth account into the account quota row and shows the built-in login as CLI-managed', async () => {
  const relay = {
    id: 'relay',
    displayName: 'Relay',
    clientId: 'anthropic',
    authType: 'oauth',
    baseUrl: 'https://relay',
  };
  const { context, read } = bindAccounts([builtin, relay], vi.fn());
  await read();
  const [row, relayRow] = rows(context);
  expect(row.state).toBe('cliManaged');
  expect(row.quota).toBe(true);
  expect(relayRow.quota).toBe(false);
  expect(row.quotaData).toEqual({
    items: [
      {
        window: 'five_hour',
        label: 'five_hour (claude-haiku-4-5)',
        left: 75,
        low: false,
        resetAt: (SEC + 3600) * 1000,
      },
      {
        window: 'seven_day',
        label: 'seven_day (claude-fable-5-1)',
        left: 50,
        low: false,
        resetAt: (SEC + 86400) * 1000,
      },
      {
        window: 'seven_day_overage_included',
        label: 'seven_day_overage_included (claude-fable-5-1)',
        left: 10,
        low: true,
        resetAt: (SEC + 86400) * 1000,
      },
      { window: '', label: 'seven_day_opus (claude-fable-5-1)', left: 60, low: false, resetAt: null },
    ],
    resets: [{ at: (SEC + 3600) * 1000 }, { at: (SEC + 86400) * 1000 }, { at: (SEC + 86400) * 1000 }],
    at: NOW - 30000,
    hasAt: true,
    out: false,
    fail: '',
  });
});

it('marks a reading stale once its reset passed or it is ten minutes old', async () => {
  const old = {
    ...builtin,
    claudeQuota: {
      samples: {
        haiku: { observedAt: NOW - 600000, windows: { five_hour: { utilization: 0.2, resetsAt: SEC + 60 } } },
      },
    },
  };
  const { context, read } = bindAccounts([old], vi.fn());
  await read();
  expect(rows(context)[0].quotaData.fail).toBe('stale');
});

it('reads Claude quota through the Claude endpoint and keeps the stored reading when the read fails', async () => {
  const post = vi
    .fn()
    .mockResolvedValueOnce({ accountRef: 'claude', claudeQuota: builtin.claudeQuota })
    .mockRejectedValueOnce(Object.assign(new Error('claude_quota_owner_unknown'), { status: 503 }))
    .mockRejectedValueOnce(Object.assign(new Error('claude_quota_credential_changed'), { status: 409 }));
  const { context, read } = bindAccounts([builtin], post);
  await read();
  await runInContext('A.accQuota({ k: "claude" })', context);
  expect(post).toHaveBeenCalledWith('/api/accounts/claude/claude/quota');
  expect(rows(context)[0].quotaData.fail).toBe('');
  await runInContext('A.accQuota({ k: "claude" })', context);
  let row = rows(context)[0];
  expect(row.quotaData.fail).toBe('owner_unknown');
  expect(row.quotaData.items).toHaveLength(4);
  expect(row.quotaBusy).toBe(false);
  await runInContext('A.accQuota({ k: "claude" })', context);
  row = rows(context)[0];
  expect(row.quotaIdentityChanged).toBe(true);
  expect(row.quotaData.fail).toBe('');
});

it("draws a family's bar from its accounts in use, over windows not yet reset, and AGY's Gemini pool", async () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const agy = (id: string, gemini: number, other: number) => ({
    id,
    displayName: id,
    agy: true,
    authType: 'oauth',
    agyQuotaReady: true,
    agyQuota: {
      observedAt: NOW - 60000,
      items: [
        { label: 'Gemini', usedPercent: gemini, poolId: 'agy-gemini', resetsAt: iso(NOW + 3600000) },
        { label: 'Claude · GPT', usedPercent: other, poolId: 'agy-claude-gpt', resetsAt: iso(NOW + 3600000) },
      ],
    },
  });
  const kimi = {
    id: 'kimi',
    displayName: 'Kimi',
    clientId: 'kimi',
    authType: 'oauth',
    kimiLoginReady: true,
    kimiQuota: {
      observedAt: NOW - 7200000,
      items: [
        { label: 'week', usedPercent: 100, resetsAt: iso(NOW - 60000) },
        { label: '5h', usedPercent: 100, resetsText: 'Resets in 1h' },
        { label: 'day', usedPercent: 40, resetsText: 'Resets in 3h' },
      ],
    },
  };
  const providers = [agy('agy-used', 30, 100), agy('agy-idle', 100, 100), kimi];
  const get = (path: string) =>
    path === '/api/accounts'
      ? { providers }
      : path === '/api/config/quota-pin'
        ? { pinned: true, selectedAccountRefs: null }
        : { selection: { members: path.includes('/agy/') ? [{ id: 'siamese', accountRef: 'agy-used' }] : [] } };
  const { context, read, need } = bindAccounts(providers, vi.fn(), get, [{ id: 'kimi-cat', accountRef: 'kimi' }]);
  await read();
  await need('quotaPin');
  const bar = (family: string) =>
    runInContext('VM.quotaPin().bars', context).find((b: { family: string }) => b.family === family);
  // The idle account's 0% and the other pool's 0% are not the family's reading.
  expect(bar('agy')).toMatchObject({ left: 70, low: false });
  // "week" already reset, and "5h" reset an hour after a reading two hours old: only "day" is current.
  expect(bar('kimi')).toMatchObject({ left: 60, low: false });
});
