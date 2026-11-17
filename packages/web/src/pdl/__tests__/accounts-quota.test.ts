import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

const NOW = Date.UTC(2026, 10, 16, 2, 0);
const SEC = NOW / 1000;
const selection = { accountRef: 'claude', members: [] };

function bindAccounts(providers: unknown[], post: (path: string) => Promise<unknown>) {
  let needed: (diff: { added: string[]; removed: string[] }) => void = () => {};
  let pending: Promise<unknown> = Promise.resolve();
  const context = createContext({
    S: {},
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
    dataOk: vi.fn(),
    dataError: vi.fn(),
    chatDataRender: async () => {},
    document: { addEventListener: vi.fn(), hidden: false },
    api: {
      now: () => NOW,
      on: (_: string, fn: typeof needed) => {
        needed = fn;
      },
      get: async (path: string) => (path === '/api/accounts' ? { providers } : { selection }),
      post: (path: string) => post(path),
    },
  });
  runInContext(`${readFileSync('public/pdl-app/accounts.js', 'utf8')}\nbindAccounts();`, context);
  return {
    context,
    read: () => {
      needed({ added: ['accounts'], removed: [] });
      return pending;
    },
  };
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
      { window: 'five_hour', label: 'five_hour (claude-haiku-4-5)', left: 75, low: false },
      { window: 'seven_day', label: 'seven_day (claude-fable-5-1)', left: 50, low: false },
      {
        window: 'seven_day_overage_included',
        label: 'seven_day_overage_included (claude-fable-5-1)',
        left: 10,
        low: true,
      },
      { window: '', label: 'seven_day_opus (claude-fable-5-1)', left: 60, low: false },
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
