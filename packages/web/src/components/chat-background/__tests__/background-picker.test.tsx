import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { writeShellLanguage } from '../../shell/shell-language';
import { sampleBackgroundOpacity } from '../background-sampling';
import { ChatBackgroundPicker } from '../ChatBackgroundPicker';
import { ChatBackgroundProvider } from '../ChatBackgroundProvider';
import { backgroundResponse } from './background-test-response';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useActualColours', () => ({ useActualColours: () => undefined }));
vi.mock('@/hooks/useCafeTheme', () => ({ useCafeTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('../background-sampling', () => ({ sampleBackgroundOpacity: vi.fn(async () => ({ light: 0.2, dark: 0.2 })) }));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  writeShellLanguage('zh');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const mount = (enabled: boolean) =>
  act(async () =>
    root.render(
      <ChatBackgroundProvider enabled={enabled}>
        <ChatBackgroundPicker />
      </ChatBackgroundProvider>,
    ),
  );

it('disables the picker when its shell does not support backgrounds', async () => {
  await mount(false);
  const choices = [...host.querySelectorAll('button')];
  expect(choices.length).toBeGreaterThan(0);
  expect(choices.every((button) => button.disabled)).toBe(true);
  expect(apiFetch).not.toHaveBeenCalled();
});

it('clears an earlier error after the later queued save succeeds', async () => {
  let release: (response: Response) => void = () => undefined;
  const first = new Promise<Response>((resolve) => {
    release = resolve;
  });
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(Response.json({ threads: {} }))
    .mockReturnValueOnce(first)
    .mockResolvedValueOnce(Response.json({ global: { kind: 'none' }, threads: {} }));
  await mount(true);
  const none = host.querySelector<HTMLButtonElement>('button[aria-label="无"]');
  await act(async () => {
    none?.click();
    none?.click();
  });
  await act(async () => {
    release(new Response('failed', { status: 500 }));
  });
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it.each([
  { label: 'automatic', opacity: { light: 0.2, dark: 0.2 }, expected: { light: 0.12, dark: 0.1 } },
  { label: 'manual Light', opacity: { light: 0.35, dark: 0.2 }, expected: { light: 0.35, dark: 0.1 } },
])('keeps $label intent when fill changes to center without touching the slider', async ({ opacity, expected }) => {
  const image = {
    kind: 'image' as const,
    url: '/backgrounds/cafe-night.jpg',
    name: 'Café',
    placement: 'fill' as const,
    opacity,
    recommendedOpacity: { light: 0.2, dark: 0.2 },
  };
  vi.mocked(sampleBackgroundOpacity).mockResolvedValue({ light: 0.12, dark: 0.1 });
  vi.mocked(apiFetch).mockImplementation(async (_url, init) =>
    Response.json(
      init?.method === 'PUT'
        ? backgroundResponse(JSON.parse(String(init.body)).background, JSON.parse(String(init.body)).metadata)
        : backgroundResponse(image),
    ),
  );
  await mount(true);
  await act(async () => {
    [...host.querySelectorAll('button')].find((button) => button.textContent === '居中')?.click();
  });
  expect(sampleBackgroundOpacity).toHaveBeenCalledWith(image.url, 'center', undefined);
  const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PUT');
  expect(writes).toHaveLength(1);
  const saved = JSON.parse(String(writes[0][1]?.body)).background;
  expect(saved.placement).toBe('center');
  expect(saved.opacity).toEqual(expected);
  expect(saved.recommendedOpacity).toEqual({ light: 0.12, dark: 0.1 });
  expect(host.textContent?.includes('再往右，有些灰字会看不清')).toBe(opacity.light === 0.35);
});

it('removes the failed-load retry when a supported shell becomes unsupported', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response('failed', { status: 500 }));
  await mount(true);
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.textContent).toContain('重试');
  await mount(false);
  expect([...host.querySelectorAll('button')].filter((button) => !button.disabled)).toEqual([]);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

it("starts at the quieter 20% cap while retaining each mode's actual readability boundary", async () => {
  vi.mocked(sampleBackgroundOpacity).mockResolvedValue({ light: 0.38, dark: 0.13 });
  vi.mocked(apiFetch).mockImplementation(async (_url, init) =>
    Response.json(
      init?.method === 'PUT'
        ? backgroundResponse(JSON.parse(String(init.body)).background, JSON.parse(String(init.body)).metadata)
        : { threads: {} },
    ),
  );
  await mount(true);
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="黄昏的云"]')?.click());
  const write = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'PUT');
  const saved = JSON.parse(String(write?.[1]?.body)).background;
  expect(saved.opacity).toEqual({ light: 0.2, dark: 0.13 });
  expect(saved.recommendedOpacity).toEqual(saved.opacity);
  expect(JSON.parse(String(write?.[1]?.body)).metadata.readableOpacity).toEqual({ light: 0.38, dark: 0.13 });
});

it('warns above readability, rather than above the quieter automatic recommendation', async () => {
  const image = {
    kind: 'image' as const,
    url: '/backgrounds/sunset-clouds.jpg',
    name: 'Sunset',
    placement: 'fill' as const,
    opacity: { light: 0.3, dark: 0.2 },
    recommendedOpacity: { light: 0.2, dark: 0.2 },
    readableOpacity: { light: 0.38, dark: 0.25 },
  };
  vi.mocked(apiFetch).mockResolvedValue(Response.json(backgroundResponse(image)));
  await mount(true);
  expect(host.querySelector<HTMLInputElement>('input[type="range"]')?.value).toBe('30');
  expect(host.textContent).not.toContain('再往右，有些灰字会看不清');
});
