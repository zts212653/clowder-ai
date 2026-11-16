import type { ClaudeQuotaView } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { ClaudeQuotaControl } from '../accounts/ClaudeQuotaControl';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const now = Date.parse('2026-11-16T22:00:00Z');
const weeklyReset = Date.parse('2026-11-16T23:00:00Z') / 1000;
const reading: ClaudeQuotaView = {
  samples: {
    'claude-fable-5': {
      observedAt: now - 1000,
      windows: {
        seven_day: { utilization: 0.88, resetsAt: weeklyReset },
        seven_day_overage_included: { utilization: 0.54, resetsAt: weeklyReset },
        future_model_limit: {},
      },
    },
    'claude-haiku-5-5': { observedAt: now, windows: { seven_day: { utilization: 0.89, resetsAt: weeklyReset } } },
  },
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('shows shared and Fable limits, retains unknown keys, and labels each sampling time', async () => {
  await act(async () =>
    root.render(<ClaudeQuotaControl accountRef="a" observation={reading} reload={async () => {}} />),
  );
  expect(host.textContent).toContain('本周（全部模型）');
  expect(host.textContent).toContain('剩 11%');
  expect(host.textContent).toContain('本周（Fable）');
  expect(host.textContent).toContain('剩 46%');
  expect(host.textContent).toContain('future_model_limit');
  expect(host.querySelectorAll('.claude-quota-time')).toHaveLength(3);
  expect(host.querySelector('[title="seven_day_overage_included · claude-fable-5"]')).not.toBeNull();
  const buttons = [...host.querySelectorAll('button')];
  expect(buttons.find((button) => button.textContent === '读取余量')?.title).toContain('Haiku、Fable');
  expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
});

it('crossing reset marks the historical reading rather than fabricating a full balance', async () => {
  vi.setSystemTime(weeklyReset * 1000 - 500);
  await act(async () =>
    root.render(<ClaudeQuotaControl accountRef="a" observation={reading} reload={async () => {}} />),
  );
  await act(async () => {
    vi.advanceTimersByTime(501);
  });
  expect(host.textContent).toContain('已过重置时间');
  expect(host.textContent).toContain('上次读数');
  expect(host.textContent).toContain('剩 46%');
  expect(host.textContent).not.toContain('剩 100%');
  expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
});

it('explicit reads target the row account and credential-change errors remove unverified history after reload', async () => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ error: 'claude_quota_credential_changed' }, { status: 409 }));
  const reload = vi.fn(async () => {
    root.render(<ClaudeQuotaControl accountRef="b" reload={reload} />);
  });
  await act(async () => root.render(<ClaudeQuotaControl accountRef="b" observation={reading} reload={reload} />));
  await act(async () => host.querySelector<HTMLButtonElement>('button')?.click());
  expect(vi.mocked(apiFetch).mock.calls[0][0]).toBe('/api/accounts/b/claude/quota');
  expect(reload).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('此号的登录已变化');
  expect(host.textContent).toContain('尚无可确认的读数');
  expect(host.textContent).not.toContain('剩 46%');
});
