import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { primeCoCreatorConfigCache, resetCoCreatorConfigCacheForTest } from '@/hooks/useCoCreatorConfig';
import { hexToOklch } from '@/lib/color-utils';
import { CoCreatorHueInjector } from '../CoCreatorHueInjector';

// The hook asks the API for the config on mount; this file decides when (and whether) the config arrives.
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(() => new Promise(() => undefined)) }));

/**
 * F322 B segment 1 (human message) — the human colour reaches the message through the same F056 chain the cats use:
 * config -> hue / chroma on the page -> `--color-cocreator-*` roles (the Tuner's lightness steps still apply) -> the bubble.
 * Only in the new presentation, so the classic UI keeps the look it has always had.
 */
const STYLE_ID = 'f322-cocreator-roles';
const style = () => document.getElementById(STYLE_ID) as HTMLStyleElement | null;

describe('CoCreatorHueInjector', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    resetCoCreatorConfigCacheForTest();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    style()?.remove();
    resetCoCreatorConfigCacheForTest();
  });

  const base = { name: 'You', aliases: [], mentionPatterns: ['@co-creator'] };

  describe('CoCreatorHueInjector', () => {
    const mount = () => act(() => root.render(<CoCreatorHueInjector />));

    it('writes nothing while the config is pending or has no colour', () => {
      mount();
      expect(style()).toBeNull();
      act(() => primeCoCreatorConfigCache(base));
      expect(style()).toBeNull();
    });

    it('writes the hue and chroma of the configured colour, scoped to the new presentation only', () => {
      mount();
      act(() => primeCoCreatorConfigCache({ ...base, color: { primary: '#815b5b', secondary: '#FFDDD2' } }));

      const { h, c } = hexToOklch('#815b5b');
      const css = style()?.textContent ?? '';
      expect(css).toContain('html[data-shell="v2"]');
      expect(css).toContain(`--cocreator-hue:${h.toFixed(1)}`);
      expect(css).toContain(`--cocreator-chroma:${c.toFixed(3)}`);
      // Classic is untouched: the rule is not on :root.
      expect(css).not.toContain(':root');
    });

    it('follows a changed configuration and removes itself when the colour is taken away', () => {
      mount();
      act(() => primeCoCreatorConfigCache({ ...base, color: { primary: '#815b5b', secondary: '#FFDDD2' } }));
      const before = style()?.textContent;

      act(() => primeCoCreatorConfigCache({ ...base, color: { primary: '#6B5443', secondary: '#E9DCCF' } }));
      expect(style()?.textContent).not.toBe(before);
      expect(style()?.textContent).toContain(`--cocreator-hue:${hexToOklch('#6B5443').h.toFixed(1)}`);
      expect(document.querySelectorAll(`#${STYLE_ID}`)).toHaveLength(1);

      act(() => primeCoCreatorConfigCache(base));
      expect(style()).toBeNull();
    });

    it('cleans up after itself when it unmounts', () => {
      mount();
      act(() => primeCoCreatorConfigCache({ ...base, color: { primary: '#815b5b', secondary: '#FFDDD2' } }));
      expect(style()).not.toBeNull();
      act(() => root.render(<div />));
      expect(style()).toBeNull();
    });
  });
});
