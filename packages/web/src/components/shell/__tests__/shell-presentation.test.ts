// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseShellPresentationParam,
  readShellPresentation,
  SHELL_PRESENTATION_STORAGE_KEY,
  writeShellPresentation,
} from '../shell-presentation';

describe('F322 shell presentation switch', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it('defaults to classic so the old shell is untouched until someone opts in', () => {
    expect(readShellPresentation()).toBe('classic');
  });

  it('persists v2 and classic, and ignores anything else', () => {
    writeShellPresentation('v2');
    expect(readShellPresentation()).toBe('v2');
    writeShellPresentation('classic');
    expect(readShellPresentation()).toBe('classic');
    window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'something-else');
    expect(readShellPresentation()).toBe('classic');
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
