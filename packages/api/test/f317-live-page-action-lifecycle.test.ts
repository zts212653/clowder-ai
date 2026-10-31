import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import {
  type LivePageActionPort,
  pageActionGrantSha256,
  runLivePageAction,
} from '../src/domains/concierge/action/LivePageAction.js';
import type { PageActionResult } from '../src/domains/concierge/action/PageActionLoop.js';

function setup() {
  const controller = new AbortController();
  const scope = {
    userId: 'owner',
    threadId: 'home',
    catId: createCatId('codex6-sol'),
    invocationId: 'invocation-1',
    callId: 'call-1',
    generation: 1,
  };
  const request = { sourceRef: 'home#owner-message-1', revision: 'r1', text: 'Fill the note' };
  const candidate = { id: 'note', operation: 'fill' as const, label: 'Note', fingerprint: 'input|note|1' };
  const grant = {
    authorityId: 'grant-1',
    permissionScope: 'fixture-note',
    expiresAtMs: Date.now() + 60_000,
    action: {
      origin: 'http://127.0.0.1:5227',
      url: 'http://127.0.0.1:5227/',
      requestRevision: 'r1',
      actions: [
        {
          targetId: 'note',
          operation: 'fill' as const,
          value: 'filled',
          fingerprint: candidate.fingerprint,
          expectedReadback: 'filled',
        },
      ],
    },
  };
  let readback = 'empty',
    effects = 0,
    closeCalls = 0;
  let onClose: () => Promise<void> = async () => {};
  const admission = {
    scope,
    request,
    grant,
    signal: controller.signal,
    async readCurrent() {
      return {
        scope,
        request: {
          sourceRef: request.sourceRef,
          revision: request.revision,
          textSha256: createHash('sha256').update(request.text).digest('hex'),
          kind: 'direct_owner' as const,
        },
        grant: {
          authorityId: grant.authorityId,
          permissionScope: grant.permissionScope,
          expiresAtMs: grant.expiresAtMs,
          actionSha256: pageActionGrantSha256(grant.action),
        },
      };
    },
  };
  const selector = {
    async select(input: { signal: AbortSignal }) {
      assert.equal(input.signal, controller.signal);
      return { kind: 'act' as const, targetId: 'note', operation: 'fill' as const, value: 'filled' };
    },
  };
  const port: LivePageActionPort = {
    async inspect() {
      return { origin: grant.action.origin, url: grant.action.url, readback, candidates: [candidate] };
    },
    async perform(_choice, _fingerprint, _url, _revision, fence) {
      const state = await fence();
      if (state !== 'current') return state;
      effects++;
      readback = 'filled';
      return 'applied';
    },
    async close() {
      closeCalls++;
      await onClose();
    },
  };
  return {
    admission,
    selector,
    port,
    controller,
    effects: () => effects,
    closeCalls: () => closeCalls,
    onClose: (callback: () => Promise<void>) => {
      onClose = callback;
    },
  };
}

async function settleSoon(pending: Promise<PageActionResult>) {
  return Promise.race([
    pending,
    new Promise<{ status: 'timeout_after_abort' }>((resolve) =>
      setTimeout(() => resolve({ status: 'timeout_after_abort' }), 450),
    ),
  ]);
}

test('stop settles a hanging initial inspection and closes the actor', async () => {
  const x = setup();
  x.port.inspect = async () => new Promise<never>(() => {});
  const pending = runLivePageAction(x);
  setTimeout(() => x.controller.abort('stopped'), 10);
  assert.equal((await settleSoon(pending)).status, 'cancelled');
  assert.equal(x.closeCalls(), 1);
  assert.equal(x.effects(), 0);
});

test('stop settles a hanging selector before effect', async () => {
  const x = setup();
  x.selector.select = async () => new Promise<never>(() => {});
  const pending = runLivePageAction(x);
  setTimeout(() => x.controller.abort('stopped'), 10);
  assert.equal((await settleSoon(pending)).status, 'cancelled');
  assert.equal(x.closeCalls(), 1);
});

test('stop during a hanging perform is unknown and closes the actor', async () => {
  const x = setup();
  x.port.perform = async () => new Promise<never>(() => {});
  const pending = runLivePageAction(x);
  setTimeout(() => x.controller.abort('stopped'), 10);
  assert.equal((await settleSoon(pending)).status, 'unknown');
  assert.equal(x.closeCalls(), 1);
});

test('stop during a hanging post-effect readback is unknown', async () => {
  const x = setup();
  const inspect = x.port.inspect;
  x.port.inspect = async () => {
    if (x.effects() === 1) {
      setTimeout(() => x.controller.abort('stopped'), 10);
      return new Promise<never>(() => {});
    }
    return inspect();
  };
  assert.equal((await settleSoon(runLivePageAction(x))).status, 'unknown');
  assert.equal(x.effects(), 1);
  assert.equal(x.closeCalls(), 1);
});

test('a hung actor close yields a bounded unknown result', async () => {
  const x = setup();
  x.onClose(async () => new Promise<never>(() => {}));
  x.controller.abort('stopped');
  assert.equal((await settleSoon(runLivePageAction(x))).status, 'unknown');
  assert.equal(x.closeCalls(), 1);
});
