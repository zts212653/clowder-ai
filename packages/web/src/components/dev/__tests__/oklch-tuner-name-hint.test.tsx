import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { NamePlateResult } from '@/lib/readable-name-plate';
import { NAME_ROLE_MIN_CONTRAST } from '@/lib/readable-name-role';
import { NameRoleHint, nameRoleHintState } from '../oklch-tuner-name-hint';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * F322 B follow-up (Opus 5.5 3619): the Tuner says nothing when the saved name is what is drawn; says "显示时已调到可读" with
 * the saved and the drawn values side by side when the drawn lightness moved (the name, the plate, or both); and says the name
 * does not read, with the best figure it reached, when no lightness reads. The unreadable figure is never counted as a pass.
 */
const SAVED = { nameL: 0.78, plateL: 0.5, c: 0.025, h: 144 };
const result = (over: Partial<NamePlateResult>): NamePlateResult => ({
  l: 0.78,
  adjusted: false,
  reachable: true,
  plateL: 0.5,
  plateShifted: false,
  worst: 7,
  ...over,
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function render(drawn: NamePlateResult): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<NameRoleHint saved={SAVED} drawn={drawn} />));
  return container;
}

describe('nameRoleHintState', () => {
  it('is "reads" when nothing moved and the name reads', () => {
    expect(nameRoleHintState(result({}))).toBe('reads');
  });
  it('is "adjusted" when the name moved, or the plate moved, or both', () => {
    expect(nameRoleHintState(result({ adjusted: true, l: 0.34 }))).toBe('adjusted');
    expect(nameRoleHintState(result({ plateShifted: true, plateL: 0.62 }))).toBe('adjusted');
    expect(nameRoleHintState(result({ adjusted: true, plateShifted: true }))).toBe('adjusted');
  });
  it('is "unreadable" whenever the result is not reached, even if something also moved', () => {
    expect(nameRoleHintState(result({ reachable: false, worst: 3.2 }))).toBe('unreadable');
    expect(nameRoleHintState(result({ reachable: false, plateShifted: true, adjusted: true }))).toBe('unreadable');
  });
});

describe('NameRoleHint', () => {
  it('renders nothing when the saved name is what is drawn', () => {
    const host = render(result({}));
    expect(host.querySelector('[data-testid="tuner-name-hint"]')).toBeNull();
  });

  it('says the name was adjusted and shows the saved and the drawn name side by side', () => {
    const host = render(result({ adjusted: true, l: 0.34 }));
    const hint = host.querySelector('[data-testid="tuner-name-hint"]');
    expect(hint?.getAttribute('data-state')).toBe('adjusted');
    expect(host.querySelector('[data-testid="tuner-name-hint-title"]')?.textContent).toBe('显示时已调到可读');
    const name = host.querySelector('[data-testid="tuner-name-hint-name"]')?.textContent ?? '';
    expect(name).toContain('你存的 L 0.780');
    expect(name).toContain('实际显示 L 0.340');
    expect(host.querySelector('[data-testid="tuner-name-hint-plate"]')).toBeNull();
    expect(hint?.textContent).toContain('已存的值没有改');
  });

  it('shows the plate line only when the plate moved, and the name line only when the name moved', () => {
    const plateOnly = render(result({ plateShifted: true, plateL: 0.62 }));
    const plate = plateOnly.querySelector('[data-testid="tuner-name-hint-plate"]')?.textContent ?? '';
    expect(plate).toContain('你存的 L 0.500');
    expect(plate).toContain('实际显示 L 0.620');
    expect(plateOnly.querySelector('[data-testid="tuner-name-hint-name"]')).toBeNull();
    act(() => root?.unmount());
    plateOnly.remove();

    const both = render(result({ adjusted: true, l: 0.34, plateShifted: true, plateL: 0.62 }));
    expect(both.querySelector('[data-testid="tuner-name-hint-name"]')).not.toBeNull();
    expect(both.querySelector('[data-testid="tuner-name-hint-plate"]')).not.toBeNull();
  });

  it('draws the swatches in the saved hue and chroma at the saved and at the drawn lightness', () => {
    const host = render(result({ adjusted: true, l: 0.34 }));
    const swatches = [...host.querySelectorAll('[data-testid="tuner-name-hint-name"] span[style]')].map(
      (el) => (el as HTMLElement).getAttribute('style') ?? '',
    );
    expect(swatches).toHaveLength(2);
    expect(swatches[0]).toContain('oklch(0.78 0.025 144)');
    expect(swatches[1]).toContain('oklch(0.34 0.025 144)');
  });

  describe('every field that moved is shown in the "not reached" state too (codex-sol #5086 P2)', () => {
    it('plate moved: the plate line is there, the name line is not', () => {
      const host = render(result({ reachable: false, worst: 4.135, plateShifted: true, plateL: 0.964 }));
      const plate = host.querySelector('[data-testid="tuner-name-hint-plate"]')?.textContent ?? '';
      expect(host.querySelector('[data-testid="tuner-name-hint"]')?.getAttribute('data-state')).toBe('unreadable');
      expect(plate).toContain('你存的 L 0.500');
      expect(plate).toContain('实际显示 L 0.964');
      expect(host.querySelector('[data-testid="tuner-name-hint-name"]')).toBeNull();
    });

    it('name moved: the name line is there, the plate line is not', () => {
      const host = render(result({ reachable: false, worst: 3.5, adjusted: true, l: 0.54 }));
      const name = host.querySelector('[data-testid="tuner-name-hint-name"]')?.textContent ?? '';
      expect(name).toContain('你存的 L 0.780');
      expect(name).toContain('实际显示 L 0.540');
      expect(host.querySelector('[data-testid="tuner-name-hint-plate"]')).toBeNull();
    });

    it('both moved: both lines', () => {
      const host = render(
        result({ reachable: false, worst: 4.27, adjusted: true, l: 0.39, plateShifted: true, plateL: 0.964 }),
      );
      expect(host.querySelector('[data-testid="tuner-name-hint-name"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="tuner-name-hint-plate"]')).not.toBeNull();
    });

    it('nothing moved: no delta lines, only the not-reached statement', () => {
      const host = render(result({ reachable: false, worst: 3.2 }));
      expect(host.querySelector('[data-testid="tuner-name-hint-name"]')).toBeNull();
      expect(host.querySelector('[data-testid="tuner-name-hint-plate"]')).toBeNull();
      expect(host.querySelector('[data-testid="tuner-name-hint"]')?.textContent).toContain('没有达到 4.5:1');
    });
  });

  it('says it is not reached, with the best figure, and rounds down so the figure never meets the criterion', () => {
    const host = render(result({ reachable: false, l: 0.46, worst: 4.4999 }));
    const hint = host.querySelector('[data-testid="tuner-name-hint"]');
    expect(hint?.getAttribute('data-state')).toBe('unreadable');
    const title = host.querySelector('[data-testid="tuner-name-hint-title"]')?.textContent ?? '';
    expect(title).toBe('这组颜色下名字读不清（最高 4.49:1）');
    expect(Number(title.match(/(\d+\.\d+):1/)?.[1])).toBeLessThan(NAME_ROLE_MIN_CONTRAST);
    expect(hint?.textContent).toContain('没有达到 4.5:1');
    expect(hint?.textContent).not.toContain('显示时已调到可读');
  });
});
