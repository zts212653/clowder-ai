import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { DshConnectionStatus } from '../settings/members/DshConnectionStatus';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

it.each(['passed', 'failed'] as const)('keeps %s diagnostics explicit and refreshes without billing', async (state) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  let finish!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementation(async (_path, request) => {
    if (request?.method === 'POST') return new Promise<Response>((resolve) => (finish = resolve));
    return Response.json({
      state: 'unchecked',
      toolIssues: [{ pluginId: 'broken', capabilityId: 'plugin:broken:main', reasonCode: 'tool_schema_invalid' }],
    });
  });
  const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, request]) => request?.method === 'POST');
  const click = async (label: string) => {
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === label);
    expect(button).toBeDefined();
    await act(async () => button?.click());
  };
  try {
    await act(async () => root.render(<DshConnectionStatus member={{ id: 'whale', configurationRevision: 'r1' }} />));
    expect(host.textContent).toContain('尚未运行独立连接检查，可以直接聊天');
    expect(host.textContent).toContain('插件工具暂不可用：broken');
    expect(posts()).toHaveLength(0);
    await click('刷新状态');
    expect(vi.mocked(apiFetch).mock.calls).toHaveLength(2);
    expect(posts()).toHaveLength(0);
    await click('检查连接（可能产生模型费用）');
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0][1]?.body))).toMatchObject({ expectedRevision: 'r1' });
    expect(host.textContent).toContain('无需等待检查完成');
    await act(async () => {
      finish(
        Response.json({ state, ...(state === 'failed' ? { reasonCode: 'dsh_setup_auth_refresh_required' } : {}) }),
      );
    });
    expect(host.textContent).toContain(state === 'passed' ? '已收到所选模型的回复' : 'Desktop 登录需要更新');
    await act(async () => root.render(<DshConnectionStatus member={{ id: 'whale', configurationRevision: 'r2' }} />));
    expect(posts()).toHaveLength(1);
    expect(host.textContent).toContain('尚未运行独立连接检查');
  } finally {
    await act(async () => root.unmount());
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  }
});
