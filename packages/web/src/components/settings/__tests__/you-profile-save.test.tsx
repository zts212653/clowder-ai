import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import { apiFetch } from '@/utils/api-client';
import { writeShellLanguage } from '../../shell/shell-language';
import { YouProfileCard } from '../YouProfileCard';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCoCreatorConfig', () => ({ primeCoCreatorConfigCache: vi.fn() }));

it('omits hidden aliases and publishes the canonical save response instead of its old profile snapshot', async () => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  writeShellLanguage('zh');
  const opened = { name: 'Before', aliases: ['old alias'], mentionPatterns: ['@owner'] };
  const canonical = { ...opened, name: 'After', aliases: ['alias from another editor'] };
  vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ config: { coCreator: canonical } }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<YouProfileCard coCreator={opened} loadError={false} reload={vi.fn(async () => undefined)} />),
    );
    const name = host.querySelector<HTMLInputElement>('input[required]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'After');
      name?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const payload = JSON.parse(String(vi.mocked(apiFetch).mock.calls[0][1]?.body));
    expect(payload).not.toHaveProperty('aliases');
    expect(payload.name).toBe('After');
    expect(primeCoCreatorConfigCache).toHaveBeenCalledWith(canonical);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('allows the current You settings to select and clear a nickname without confirming an untouched legacy value', async () => {
  vi.clearAllMocks();
  writeShellLanguage('zh');
  const opened = { name: 'co-creator', nickname: '大当家', aliases: [], mentionPatterns: ['@co-creator'] };
  vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
    const patch = JSON.parse(String(init?.body));
    return Response.json({ config: { coCreator: { ...opened, ...patch } } });
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<YouProfileCard coCreator={opened} loadError={false} reload={vi.fn(async () => undefined)} />),
    );
    const input = host.querySelector<HTMLInputElement>('#you-nickname');
    expect(input).not.toBeNull();
    expect(input?.value).toBe('');
    const save = async () => {
      await act(async () => {
        host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      return JSON.parse(String(vi.mocked(apiFetch).mock.calls.at(-1)?.[1]?.body));
    };
    expect(await save()).not.toHaveProperty('nickname');
    for (const value of ['大当家', '']) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
        input?.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect((await save()).nickname).toBe(value || null);
    }
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
