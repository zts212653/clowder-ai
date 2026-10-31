// @ts-check

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('Codex app-server pool registry', () => {
  test('reuses one pool per active Codex profile and closes stale pools', async () => {
    const { closeStaleCodexAppServerPools, getOrCreateCodexAppServerPool } = await import(
      '../dist/domains/cats/services/agents/providers/codex-app-server-pool-registry.js'
    );
    const registry = new Map();
    const created = [];
    const factory = (config) => {
      const pool = {
        config,
        closeCalls: 0,
        async closeAll() {
          this.closeCalls++;
        },
      };
      created.push(pool);
      return pool;
    };

    const first = getOrCreateCodexAppServerPool(registry, 'codex-sol', factory, {
      CAT_CAFE_CODEX_APP_SERVER_IDLE_TTL_MS: '1234',
      CAT_CAFE_CODEX_APP_SERVER_MAX_WARM_HOSTS: '7',
    });
    const again = getOrCreateCodexAppServerPool(registry, 'codex-sol', factory, {});
    const stale = getOrCreateCodexAppServerPool(registry, 'codex-old', factory, {});

    assert.equal(first, again);
    assert.equal(created.length, 2);
    assert.deepEqual(first.config, { idleTtlMs: 1234, maxWarmHosts: 7 });

    const closed = await closeStaleCodexAppServerPools(registry, new Set(['codex-sol']));
    assert.deepEqual(closed, ['codex-old']);
    assert.equal(stale.closeCalls, 1);
    assert.deepEqual([...registry.keys()], ['codex-sol']);
  });

  test('invalid bounds fall back without disabling warm reuse accidentally', async () => {
    const { resolveCodexAppServerPoolConfig } = await import(
      '../dist/domains/cats/services/agents/providers/codex-app-server-pool-registry.js'
    );

    assert.deepEqual(
      resolveCodexAppServerPoolConfig({
        CAT_CAFE_CODEX_APP_SERVER_IDLE_TTL_MS: '-1',
        CAT_CAFE_CODEX_APP_SERVER_MAX_WARM_HOSTS: 'not-a-number',
      }),
      { idleTtlMs: 300_000, maxWarmHosts: 16 },
    );
    assert.deepEqual(
      resolveCodexAppServerPoolConfig({
        CAT_CAFE_CODEX_APP_SERVER_IDLE_TTL_MS: '0',
        CAT_CAFE_CODEX_APP_SERVER_MAX_WARM_HOSTS: '0',
      }),
      { idleTtlMs: 0, maxWarmHosts: 0 },
    );
  });
});
