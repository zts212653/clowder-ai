import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { buildPwaRetirementScript } from '../pwa-retirement-script';

function registration(scriptURL: string, unregisterResult = true) {
  return {
    scope: 'http://127.0.0.1:3011/',
    active: { scriptURL },
    waiting: null,
    installing: null,
    unregister: vi.fn().mockResolvedValue(unregisterResult),
  };
}

function fixture(options: {
  controllerScriptURL?: string | null;
  registrations?: ReturnType<typeof registration>[];
  cacheNames?: string[];
}) {
  const status = { dataset: {} as Record<string, string> };
  const deletedCaches: string[] = [];
  const cacheNames = new Set(options.cacheNames ?? []);
  const reload = vi.fn();
  const logFailure = vi.fn();
  const dispatchEvent = vi.fn();
  const getRegistrations = vi.fn().mockResolvedValue(options.registrations ?? []);
  const getCacheNames = vi.fn(async () => [...cacheNames]);
  const context = {
    URL,
    CustomEvent: class CustomEvent {
      constructor(
        readonly type: string,
        readonly init: { detail: unknown },
      ) {}
    },
    console: { error: logFailure },
    document: {
      querySelector: vi.fn().mockReturnValue(status),
      dispatchEvent,
    },
    location: { origin: 'http://127.0.0.1:3011', reload },
    navigator: {
      serviceWorker: {
        controller:
          options.controllerScriptURL === null
            ? null
            : { scriptURL: options.controllerScriptURL ?? 'http://127.0.0.1:3011/sw.js' },
        getRegistrations,
      },
    },
    caches: {
      keys: getCacheNames,
      delete: vi.fn(async (name: string) => {
        deletedCaches.push(name);
        return cacheNames.delete(name);
      }),
    },
  };
  return { context, status, deletedCaches, reload, logFailure, dispatchEvent, getRegistrations, getCacheNames };
}

describe('PWA retirement script', () => {
  it('unregisters only the legacy Clowder AI worker, deletes owned caches, then reloads once', async () => {
    const catCafeWorker = registration('http://127.0.0.1:3011/sw.js');
    const unrelatedWorker = registration('http://127.0.0.1:3011/other-sw.js');
    const test = fixture({
      registrations: [catCafeWorker, unrelatedWorker],
      cacheNames: [
        'workbox-precache-v2-http://127.0.0.1:3011/',
        'start-url',
        'pages',
        'next-static-js-assets',
        'third-party-cache',
      ],
    });

    await runInNewContext(buildPwaRetirementScript({ enabled: false }), test.context);

    expect(catCafeWorker.unregister).toHaveBeenCalledOnce();
    expect(unrelatedWorker.unregister).not.toHaveBeenCalled();
    expect(test.deletedCaches).toEqual([
      'workbox-precache-v2-http://127.0.0.1:3011/',
      'start-url',
      'pages',
      'next-static-js-assets',
    ]);
    expect(await test.getCacheNames()).toEqual(['third-party-cache']);
    expect(test.reload).toHaveBeenCalledOnce();
    expect(test.status.dataset).toMatchObject({
      pwaCleanupState: 'reload-required',
      pwaController: 'present',
      pwaOwnedCacheCount: '0',
    });
  });

  it('emits no executable cleanup when PWA remains enabled in production', async () => {
    const test = fixture({
      registrations: [registration('https://cafe.example/sw.js')],
      cacheNames: ['pages'],
    });
    const script = buildPwaRetirementScript({ enabled: true });

    expect(script).toBe('');
    expect(test.getRegistrations).not.toHaveBeenCalled();
    expect(test.getCacheNames).not.toHaveBeenCalled();
    expect(test.reload).not.toHaveBeenCalled();
  });

  it('fails visibly and leaves caches intact when worker retirement is refused', async () => {
    const catCafeWorker = registration('http://127.0.0.1:3011/sw.js', false);
    const test = fixture({ registrations: [catCafeWorker], cacheNames: ['pages', 'third-party-cache'] });

    await runInNewContext(buildPwaRetirementScript({ enabled: false }), test.context);

    expect(test.status.dataset).toMatchObject({
      pwaCleanupState: 'failed',
      pwaFailureCount: '1',
      pwaOwnedCacheCount: '1',
    });
    expect(test.deletedCaches).toEqual([]);
    expect(test.reload).not.toHaveBeenCalled();
    expect(test.logFailure).toHaveBeenCalledOnce();
    expect(test.dispatchEvent).toHaveBeenCalledOnce();
  });

  it('reports clean state without deleting or reloading in a fresh disabled client', async () => {
    const test = fixture({ controllerScriptURL: null, cacheNames: ['third-party-cache'] });

    await runInNewContext(buildPwaRetirementScript({ enabled: false }), test.context);

    expect(test.status.dataset).toMatchObject({
      pwaCleanupState: 'clean',
      pwaController: 'none',
      pwaOwnedCacheCount: '0',
    });
    expect(test.deletedCaches).toEqual([]);
    expect(test.reload).not.toHaveBeenCalled();
  });
});
