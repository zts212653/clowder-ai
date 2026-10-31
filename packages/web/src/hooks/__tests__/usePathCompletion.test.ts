import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePathCompletion } from '../usePathCompletion';

let completion: ReturnType<typeof usePathCompletion>;
let root: Root;
let host: HTMLDivElement;
function CompletionHost() {
  completion = usePathCompletion('');
  return null;
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  root = createRoot(host);
  act(() => root.render(createElement(CompletionHost)));
});
afterEach(() => {
  act(() => root.unmount());
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('usePathCompletion production path detection', () => {
  it('detects relative paths with ./', () => {
    expect(completion.detectPath('./src/foo')).toBe('./src/foo');
  });

  it('detects parent paths with ../', () => {
    expect(completion.detectPath('hello ../foo')).toBe('../foo');
  });

  it('detects home paths with ~/', () => {
    expect(completion.detectPath('look at ~/projects')).toBe('~/projects');
  });

  it('detects absolute paths', () => {
    expect(completion.detectPath('/etc/passwd')).toBe('/etc/passwd');
  });

  it('detects packages/ prefix', () => {
    expect(completion.detectPath('check packages/web/src')).toBe('packages/web/src');
  });

  it('detects path at start of string', () => {
    expect(completion.detectPath('./foo')).toBe('./foo');
  });

  it('detects path after space', () => {
    expect(completion.detectPath('open ./bar')).toBe('./bar');
  });

  it('returns null for non-path input', () => {
    expect(completion.detectPath('hello world')).toBeNull();
    expect(completion.detectPath('')).toBeNull();
    expect(completion.detectPath('just a sentence')).toBeNull();
  });

  it('handles trailing slash', () => {
    expect(completion.detectPath('./src/')).toBe('./src/');
  });

  it('handles dots and underscores in filenames', () => {
    expect(completion.detectPath('./src/my_file.test.ts')).toBe('./src/my_file.test.ts');
  });

  it('handles hyphens in path', () => {
    expect(completion.detectPath('packages/web/src/chat-input-options')).toBe('packages/web/src/chat-input-options');
  });
});
