import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { PluginVisual } from '../PluginVisual';

it('uses a theme-colored SVG mask without an avatar tile in the rail, keeping settings unchanged', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const icon = { type: 'svg' as const, src: '/api/plugin-manager/plugins/official.feedback/icon' };
  act(() => root.render(<PluginVisual icon={icon} name="反馈" iconBg="#ffffff" variant="rail" />));
  const rail = container.querySelector<HTMLElement>('[data-plugin-icon]')!;
  expect(rail.style.backgroundColor).toBe('transparent');
  expect(rail.classList.contains('settings-resource-avatar')).toBe(false);
  expect(rail.style.color).toBe('inherit');
  expect(rail.querySelector('img')).toBeNull();
  expect(rail.querySelector<HTMLElement>('[aria-hidden]')!.style.mask).toContain(icon.src);
  act(() => root.render(<PluginVisual icon={icon} name="反馈" iconBg="#ffffff" />));
  const avatar = container.querySelector<HTMLElement>('[data-plugin-icon]')!;
  expect(avatar.classList.contains('settings-resource-avatar')).toBe(true);
  expect(avatar.style.backgroundColor).toBe('rgb(255, 255, 255)');
  expect(avatar.querySelector('img')?.getAttribute('src')).toBe(icon.src);
  act(() => root.unmount());
});

it('keeps raster artwork in the rail without cropping or a background tile', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(<PluginVisual icon={{ type: 'png', src: '/icon.png' }} name="图标" variant="rail" />));
  expect(container.querySelector<HTMLElement>('[data-plugin-icon]')!.style.backgroundColor).toBe('transparent');
  expect(container.querySelector('img')!.className).toContain('object-contain');
  act(() => root.unmount());
});
