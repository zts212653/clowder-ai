import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigStep } from '../first-run-quest/ConfigStep';
import type { ProfileItem } from '../hub-accounts.types';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('../UnifiedAuthModal', () => ({ UnifiedAuthModal: () => null }));

function account(id: string, displayName: string): ProfileItem {
  return {
    id,
    displayName,
    name: displayName,
    provider: 'anthropic',
    clientId: 'anthropic',
    authType: 'api_key',
    kind: 'api_key',
    builtin: false,
    mode: 'api_key',
    hasApiKey: true,
    models: ['model-a', 'model-b'],
    createdAt: '',
    updatedAt: '',
  };
}
function deferred() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const json = (body: unknown) => new Response(JSON.stringify(body));
let host: HTMLDivElement;
let root: Root;
const onComplete = vi.fn();
function button(text: string) {
  const match = [...host.querySelectorAll('button')].find((node) => node.textContent?.startsWith(text));
  if (!match) throw new Error(`Missing button: ${text}`);
  return match;
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  root = createRoot(host);
  onComplete.mockReset();
  apiFetch.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('ConfigStep discards stale connectivity responses', () => {
  it.each([
    ['account', 'success'],
    ['account', 'failure'],
    ['model', 'success'],
    ['model', 'failure'],
  ] as const)('a %s switch discards an old %s while the new probe can complete', async (change, outcome) => {
    const oldProbe = deferred();
    const newProbe = deferred();
    apiFetch
      .mockResolvedValueOnce(json({ providers: [account('claude', 'Account A'), account('profile-b', 'Account B')] }))
      .mockReturnValueOnce(oldProbe.promise)
      .mockReturnValueOnce(newProbe.promise);
    await act(async () => root.render(<ConfigStep client="claude" clientId="anthropic" onComplete={onComplete} />));
    await act(async () => button('测试连接').click());
    expect(JSON.parse(apiFetch.mock.calls[1][1].body)).toMatchObject({ profileId: 'claude', model: 'model-a' });

    act(() => button(change === 'account' ? 'Account B' : 'model-b').click());
    expect(button('请先完成连接测试').disabled).toBe(true);
    await act(async () => {
      if (outcome === 'success') oldProbe.resolve(json({ ok: true, message: 'stale A success' }));
      else oldProbe.reject(new Error('old A connection failed'));
    });
    expect(button('请先完成连接测试').disabled).toBe(true);
    expect(host.textContent).not.toContain('stale A success');
    expect(host.textContent).not.toContain('网络错误');
    expect(onComplete).not.toHaveBeenCalled();

    await act(async () => button('测试连接').click());
    await act(async () => newProbe.resolve(json({ ok: true, message: 'current B success' })));
    expect(button('创建猫猫').disabled).toBe(false);
    act(() => button('创建猫猫').click());
    expect(onComplete).toHaveBeenCalledExactlyOnceWith({
      accountRef: change === 'account' ? 'profile-b' : 'claude',
      model: change === 'account' ? 'model-a' : 'model-b',
    });
  });

  it('an old response cannot finish a newer in-flight connectivity test', async () => {
    const oldProbe = deferred();
    const newProbe = deferred();
    apiFetch
      .mockResolvedValueOnce(json({ providers: [account('claude', 'Account A'), account('profile-b', 'Account B')] }))
      .mockReturnValueOnce(oldProbe.promise)
      .mockReturnValueOnce(newProbe.promise);
    await act(async () => root.render(<ConfigStep client="claude" clientId="anthropic" onComplete={onComplete} />));
    await act(async () => button('测试连接').click());
    act(() => button('Account B').click());
    await act(async () => button('测试连接').click());
    await act(async () => oldProbe.resolve(json({ ok: true, message: 'stale A success' })));
    expect(button('测试中').disabled).toBe(true);
    expect(button('请先完成连接测试').disabled).toBe(true);
    expect(host.textContent).not.toContain('stale A success');
    await act(async () => newProbe.resolve(json({ ok: true, message: 'current B success' })));
    act(() => button('创建猫猫').click());
    expect(onComplete).toHaveBeenCalledExactlyOnceWith({ accountRef: 'profile-b', model: 'model-a' });
  });
});
