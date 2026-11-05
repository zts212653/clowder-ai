import { AsyncLocalStorage } from 'node:async_hooks';

/** Remains attached to async descendants after their request has expired; never JSON authority. */
const purpose = new AsyncLocalStorage<'browser' | 'local' | 'verifier'>();
export function currentPluginTransportPurpose(): 'browser' | 'local' | 'verifier' | undefined {
  return purpose.getStore();
}
export function withPluginTransportPurpose<T>(
  kind: 'browser' | 'local' | 'verifier',
  run: () => Promise<T>,
): Promise<T> {
  return purpose.run(kind, run);
}
