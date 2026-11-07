// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseShellPresentationParam,
  readShellPresentation,
  SHELL_PRESENTATION_STORAGE_KEY,
  useShellPresentation,
  writeShellPresentation,
} from '../shell-presentation';

describe('F322 shell presentation switch', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('defaults to v2 without writing a preference for the user', () => {
    expect(readShellPresentation()).toBe('v2');
    expect(window.localStorage.getItem(SHELL_PRESENTATION_STORAGE_KEY)).toBeNull();
  });

  it('uses the same v2 default during server rendering', () => {
    function Presentation() {
      return useShellPresentation();
    }
    expect(renderToString(createElement(Presentation))).toBe('v2');
  });

  it('defaults to v2 without a browser window or readable storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage denied', 'SecurityError');
    });
    expect(readShellPresentation()).toBe('v2');
    vi.stubGlobal('window', undefined);
    expect(readShellPresentation()).toBe('v2');
  });

  it('persists v2 and classic, and ignores anything else', () => {
    writeShellPresentation('v2');
    expect(readShellPresentation()).toBe('v2');
    writeShellPresentation('classic');
    expect(readShellPresentation()).toBe('classic');
    window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'something-else');
    expect(readShellPresentation()).toBe('v2');
  });

  it('notifies same-tab listeners when written', () => {
    let calls = 0;
    const listener = () => {
      calls += 1;
    };
    window.addEventListener('cat-cafe:shell-presentation-sync', listener);
    writeShellPresentation('v2');
    window.removeEventListener('cat-cafe:shell-presentation-sync', listener);
    expect(calls).toBe(1);
  });

  it('reads the shareable ?shell= parameter without touching storage', () => {
    expect(parseShellPresentationParam('?shell=v2')).toBe('v2');
    expect(parseShellPresentationParam('?a=1&shell=classic')).toBe('classic');
    expect(parseShellPresentationParam('?shell=nope')).toBeNull();
    expect(parseShellPresentationParam('')).toBeNull();
    expect(window.localStorage.getItem(SHELL_PRESENTATION_STORAGE_KEY)).toBeNull();
  });
});
