import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SCOPE_KEY = 'cat-cafe:settings-reading-scope:v1';
const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
const held = new Set<string>();
const request = vi.fn((name: string, _options: LockOptions, callback: LockGrantedCallback<unknown>) => {
  const lock = held.has(name) ? null : { name, mode: 'exclusive' as const };
  if (lock) held.add(name);
  return Promise.resolve(callback(lock));
});
beforeEach(() => {
  sessionStorage.clear();
  held.clear();
  request.mockClear();
  vi.resetModules();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
});
afterEach(() => {
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
  else Reflect.deleteProperty(navigator, 'locks');
});
async function scope() {
  return (await import('../settings-reading-scope')).claimSettingsReadingScope();
}
describe('Settings scope is a tab routing identity with durable payloads', () => {
  it('claims one scope across client navigation in one document', async () => {
    const first = await scope();
    expect(await scope()).toEqual(first);
    expect(first.restorable).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(SCOPE_KEY)).toBe(first.id);
    expect(sessionStorage.length).toBe(1);
  });
  it.each([
    'reload',
    'history restore',
    'hard navigation',
  ])('continues the tab trip on %s after native document teardown', async () => {
    const first = await scope();
    // Native teardown releases the lock, while this tab keeps its routing nonce.
    held.clear();
    vi.resetModules();
    expect(await scope()).toEqual(first);
    expect(localStorage.length).toBe(0);
  });
  it('claims a new scope when an opener or duplicate tab copies a still-live tab nonce', async () => {
    const first = await scope();
    vi.resetModules();
    const copied = await scope();
    expect(copied.id).not.toBe(first.id);
    expect(copied.restorable).toBe(true);
    expect(held.size).toBe(2);
    expect(sessionStorage.getItem(SCOPE_KEY)).toBe(copied.id);
  });
  it('keeps a document-isolated scope and reports that reload restoration is unavailable without native locks', async () => {
    Reflect.deleteProperty(navigator, 'locks');
    const first = await scope();
    expect(first.restorable).toBe(false);
    vi.resetModules();
    expect((await scope()).id).not.toBe(first.id);
  });
  it('keeps an honest document-only scope when routing storage rejects the nonce', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('routing storage denied');
    });
    expect((await scope()).restorable).toBe(false);
    vi.restoreAllMocks();
  });
});
