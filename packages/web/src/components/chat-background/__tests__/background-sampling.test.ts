import { afterEach, expect, it, vi } from 'vitest';
import { useSidebarStore } from '@/stores/sidebarStore';
import { backgroundTextAreas } from '../background-sampling';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

it('includes the real settings description column instead of assuming the centred chat reading column', () => {
  vi.stubGlobal('innerWidth', 1440);
  vi.stubGlobal('innerHeight', 900);
  useSidebarStore.setState({ width: 240 });
  document.body.innerHTML = `<div class="cafe-world-rail"></div><div data-testid="settings-v2"><aside data-console-panel="settings-nav"></aside><main data-background-sampling-area="settings-content"></main></div>`;
  const rect = (x: number, y: number, width: number, height: number) => ({
    x,
    y,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    width,
    height,
    toJSON() {},
  });
  vi.spyOn(document.querySelector('.cafe-world-rail')!, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 52, 900));
  vi.spyOn(document.querySelector('aside')!, 'getBoundingClientRect').mockReturnValue(rect(52, 0, 232, 900));
  vi.spyOn(document.querySelector('main')!, 'getBoundingClientRect').mockReturnValue(rect(284, 0, 1156, 900));
  const areas = backgroundTextAreas(1440, 900, 1);
  expect(
    areas.some((area) => area.x <= 316 && area.x + area.width > 316 && area.y <= 140 && area.y + area.height > 140),
  ).toBe(true);
  expect(areas).toContainEqual({ x: 52, y: 0, width: 232, height: 900 });
});
