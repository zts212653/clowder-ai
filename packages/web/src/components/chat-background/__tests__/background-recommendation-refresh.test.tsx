import {
  type ChatBackgroundImageState as ChatBackgroundImage,
  resolveChatBackgroundState as resolveChatBackground,
} from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useThemeStore } from '@/stores/themeStore';
import { apiFetch } from '@/utils/api-client';
import { sampleBackgroundOpacity } from '../background-sampling';
import { ChatBackgroundProvider, useChatBackgroundPreferences } from '../ChatBackgroundProvider';
import { useRefreshBackgroundRecommendation } from '../useRefreshBackgroundRecommendation';
import { backgroundResponse } from './background-test-response';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('../background-sampling', () => ({ sampleBackgroundOpacity: vi.fn() }));
const human = vi.hoisted(() => ({ name: 'ME', color: { primary: '#6b5443' } }));
const room = vi.hoisted(() => ({ cats: [] as { h: number; c: number }[] }));
vi.mock('@/hooks/useActualColours', () => ({
  useActualColours: () => ({ cats: room.cats, human: { h: human.color.primary === '#6b5443' ? 58 : 250, c: 0.04 } }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useSearchParams: () => new URLSearchParams('s=you'),
}));
const image = {
  kind: 'image' as const,
  url: '/backgrounds/cafe-night.jpg',
  name: 'Café',
  placement: 'fill' as const,
  opacity: { light: 0.2, dark: 0.2 },
  recommendedOpacity: { light: 0.2, dark: 0.2 },
  readableOpacity: { light: 0.2, dark: 0.2 },
};
let controller: NonNullable<ReturnType<typeof useChatBackgroundPreferences>>;
function Consumer() {
  const value = useChatBackgroundPreferences();
  if (value) controller = value;
  const current = value ? resolveChatBackground(value.preferences) : null;
  useRefreshBackgroundRecommendation(current?.kind === 'image' ? current : null, null);
  return null;
}
let host: HTMLDivElement;
let root: Root;
const originalThemes = useThemeStore.getState().themes;
beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  human.name = 'ME';
  human.color.primary = '#6b5443';
  room.cats = [];
  vi.mocked(sampleBackgroundOpacity).mockResolvedValue({ light: 0.2, dark: 0.2 });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useThemeStore.setState({ themes: originalThemes });
});
async function mount(current: ChatBackgroundImage = image, fail = false) {
  vi.mocked(apiFetch).mockImplementation(async (_url, init) =>
    init?.method === 'PUT'
      ? fail
        ? new Response('failed', { status: 500 })
        : Response.json(
            backgroundResponse(JSON.parse(String(init.body)).background, JSON.parse(String(init.body)).metadata),
          )
      : Response.json(backgroundResponse(current)),
  );
  await act(async () =>
    root.render(
      <ChatBackgroundProvider enabled>
        <Consumer />
      </ChatBackgroundProvider>,
    ),
  );
}

it('refreshes the human surface limit when its live colour changes, without resampling a name-only edit', async () => {
  await mount();
  expect(sampleBackgroundOpacity).toHaveBeenCalledTimes(1);
  vi.mocked(sampleBackgroundOpacity).mockResolvedValue({ light: 0.11, dark: 0.27 });
  human.color.primary = '#285ab0';
  await mount();
  expect(sampleBackgroundOpacity).toHaveBeenCalledTimes(2);
  expect(controller.preferences.global?.kind === 'image' && controller.preferences.global.opacity).toEqual({
    light: 0.11,
    dark: 0.2,
  });
  human.name = 'Renamed';
  await mount();
  expect(sampleBackgroundOpacity).toHaveBeenCalledTimes(2);
});
const writes = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PUT');
it('refreshes inactive palette limits when the actual cat catalogue changes', async () => {
  await mount();
  vi.mocked(sampleBackgroundOpacity).mockResolvedValue({ light: 0.12, dark: 0.14 });
  room.cats = [{ h: 250, c: 0.12 }];
  await mount();
  expect(sampleBackgroundOpacity).toHaveBeenLastCalledWith(image.url, image.placement, {
    cats: room.cats,
    human: { h: 58, c: 0.04 },
  });
  expect(controller.preferences.global?.kind === 'image' && controller.preferences.global.opacity).toEqual({
    light: 0.12,
    dark: 0.14,
  });
});
const changedThemes = () =>
  useThemeStore.setState({
    themes: originalThemes.map((theme) => {
      const params = structuredClone(theme.params);
      params.dark.elev.canvas += 0.02;
      return { ...theme, params };
    }),
  });

it('recomputes an existing automatic default after a preset edit and persists the new recommendation', async () => {
  await mount();
  expect(writes()).toHaveLength(0);
  vi.mocked(sampleBackgroundOpacity).mockResolvedValue({ light: 0.15, dark: 0.1 });
  await act(async () => changedThemes());
  const saved = JSON.parse(String(writes()[0][1]?.body)).background;
  expect(saved.opacity).toEqual({ light: 0.15, dark: 0.1 });
  expect(saved.recommendedOpacity).toEqual(saved.opacity);
});

it('preserves an explicit manual opacity while updating the recommendation for its new palette', async () => {
  vi.mocked(sampleBackgroundOpacity).mockResolvedValue({ light: 0.15, dark: 0.1 });
  await mount({ ...image, opacity: { light: 0.2, dark: 0.3 } });
  const saved = JSON.parse(String(writes()[0][1]?.body)).background;
  expect(saved.opacity).toEqual({ light: 0.15, dark: 0.3 });
  expect(saved.recommendedOpacity).toEqual({ light: 0.15, dark: 0.1 });
});

it('does not overwrite a user choice made while theme sampling is still pending', async () => {
  let release: (value: { light: number; dark: number }) => void = () => undefined;
  vi.mocked(sampleBackgroundOpacity).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await mount();
  await act(async () => {
    await controller.save({ scope: 'global', background: { kind: 'none' } });
  });
  await act(async () => {
    release({ light: 0.15, dark: 0.1 });
  });
  expect(writes()).toHaveLength(1);
  expect(controller.preferences.global).toEqual({ kind: 'none' });
});

it('does not loop automatic writes when persistence fails and rolls the preference back', async () => {
  vi.mocked(sampleBackgroundOpacity).mockResolvedValue({ light: 0.15, dark: 0.1 });
  await mount(image, true);
  expect(writes()).toHaveLength(1);
  expect(controller.preferences.global).toEqual(image);
});

it('moves stored legacy automatic opacities to the quieter default even if the readable limit is unchanged', async () => {
  vi.mocked(sampleBackgroundOpacity).mockResolvedValue({ light: 0.38, dark: 0.32 });
  await mount({ ...image, opacity: { light: 0.38, dark: 0.32 }, recommendedOpacity: { light: 0.38, dark: 0.32 } });
  expect(writes()).toHaveLength(1);
  const saved = JSON.parse(String(writes()[0][1]?.body)).background;
  expect(saved.opacity).toEqual({ light: 0.2, dark: 0.2 });
  expect(saved.recommendedOpacity).toEqual(saved.opacity);
  expect(JSON.parse(String(writes()[0][1]?.body)).metadata.readableOpacity).toEqual({ light: 0.38, dark: 0.32 });
});

it('migrates only the automatic mode of a legacy mixed manual/automatic preference', async () => {
  vi.mocked(sampleBackgroundOpacity).mockResolvedValue({ light: 0.38, dark: 0.32 });
  await mount({ ...image, opacity: { light: 0.35, dark: 0.32 }, recommendedOpacity: { light: 0.38, dark: 0.32 } });
  expect(writes()).toHaveLength(1);
  expect(JSON.parse(String(writes()[0][1]?.body)).background.opacity).toEqual({ light: 0.35, dark: 0.2 });
});

it('retains an explicit slider choice even when its value matches the previous automatic recommendation', async () => {
  vi.mocked(sampleBackgroundOpacity).mockResolvedValue({ light: 0.15, dark: 0.1 });
  await mount({ ...image, manualOpacity: { light: true } });
  expect(JSON.parse(String(writes()[0][1]?.body)).background.opacity).toEqual({ light: 0.2, dark: 0.1 });
});

it('remembers a legacy manual 20% after migration makes it equal to the new automatic default', async () => {
  vi.mocked(sampleBackgroundOpacity).mockResolvedValue({ light: 0.38, dark: 0.32 });
  await mount({ ...image, opacity: { light: 0.2, dark: 0.32 }, recommendedOpacity: { light: 0.38, dark: 0.32 } });
  expect(writes()).toHaveLength(1);
  expect(JSON.parse(String(writes()[0][1]?.body)).metadata.manualOpacity.light).toBe(true);
  vi.mocked(sampleBackgroundOpacity).mockResolvedValue({ light: 0.15, dark: 0.1 });
  await act(async () => changedThemes());
  expect(JSON.parse(String(writes()[1][1]?.body)).background.opacity).toEqual({ light: 0.2, dark: 0.1 });
});
