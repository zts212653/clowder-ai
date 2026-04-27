/**
 * F174-B P2 (cloud Codex review on PR #1363) — env validation regression test.
 *
 * Bootstrap silently fell back to memory on unknown env values (e.g. typo
 * `REDUS=redis`). User saw "redis" intent in code but ran in-memory at runtime,
 * defeating Phase B's restart-resilience收益. Helper now throws on unknown.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('selectInvocationBackendKind (F174-B P2 cloud review)', () => {
  test('returns "redis" when env=redis and Redis client available', async () => {
    const { selectInvocationBackendKind } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    assert.equal(selectInvocationBackendKind('redis', true), 'redis');
  });

  test('returns "memory" when env=memory regardless of Redis availability', async () => {
    const { selectInvocationBackendKind } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    assert.equal(selectInvocationBackendKind('memory', true), 'memory');
    assert.equal(selectInvocationBackendKind('memory', false), 'memory');
  });

  test('returns "redis" when env unset and Redis client available (default)', async () => {
    const { selectInvocationBackendKind } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    assert.equal(selectInvocationBackendKind(undefined, true), 'redis');
  });

  test('returns "memory" when env unset and Redis unavailable (degraded mode)', async () => {
    const { selectInvocationBackendKind } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    assert.equal(selectInvocationBackendKind(undefined, false), 'memory');
  });

  test('falls back to "memory" with warning when env=redis but no Redis (test envs)', async () => {
    const { selectInvocationBackendKind } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    assert.equal(selectInvocationBackendKind('redis', false), 'memory');
  });

  // The actual P2 fix: throw on typos / unknown values so they surface at boot.
  test('throws on unknown env value (typo guard) — REDUS', async () => {
    const { selectInvocationBackendKind } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    assert.throws(() => selectInvocationBackendKind('REDUS', true), /Invalid CAT_CAFE_INVOCATION_REGISTRY="REDUS"/);
  });

  test('throws on unknown env value — sqlite (proposed but not implemented)', async () => {
    const { selectInvocationBackendKind } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    assert.throws(() => selectInvocationBackendKind('sqlite', true), /Invalid CAT_CAFE_INVOCATION_REGISTRY="sqlite"/);
  });

  test('throws on empty string (defensive — empty != undefined)', async () => {
    const { selectInvocationBackendKind } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    assert.throws(() => selectInvocationBackendKind('', true), /Invalid CAT_CAFE_INVOCATION_REGISTRY=""/);
  });
});
