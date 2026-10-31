import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { pageActionGrantSha256, runLivePageAction } from '../src/domains/concierge/action/LivePageAction.ts';

const { createCdpPageActionPort } = await import(
  process.env.F317_TEST_COMPILED_ACTOR === '1'
    ? '../dist/domains/concierge/action/CdpPageActionPort.js'
    : '../src/domains/concierge/action/CdpPageActionPort.ts'
);

function stalledActionInput(controller, port, fingerprint = 'opaque') {
  const scope = {
    userId: 'owner',
    threadId: 'fixture-thread',
    catId: 'codex6-sol',
    invocationId: 'invocation',
    callId: 'call',
    generation: 1,
  };
  const request = { sourceRef: 'fixture-thread#owner-request', revision: 'r1', text: 'Fill the note' };
  const grant = {
    authorityId: 'grant',
    permissionScope: 'fixture-note',
    expiresAtMs: Date.now() + 60_000,
    action: {
      origin: 'http://127.0.0.1:5227',
      url: 'http://127.0.0.1:5227/',
      requestRevision: 'r1',
      actions: [{ targetId: 'note', operation: 'fill', value: 'filled', fingerprint, expectedReadback: 'filled' }],
    },
  };
  return {
    admission: {
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
            kind: 'direct_owner',
          },
          grant: {
            authorityId: grant.authorityId,
            permissionScope: grant.permissionScope,
            expiresAtMs: grant.expiresAtMs,
            actionSha256: pageActionGrantSha256(grant.action),
          },
        };
      },
    },
    selector: {
      async select() {
        return { kind: 'act', targetId: 'note', operation: 'fill', value: 'filled' };
      },
    },
    port,
  };
}

const stalledSpec = {
  targets: [{ id: 'note', selector: '#note-input', operation: 'fill' }],
  readback: { selector: '#readback', kind: 'text' },
};

test('stop settles a pending CDP session creation and detaches a late session', async () => {
  let releaseSession;
  let detached = false;
  let commandsAfterStop = 0;
  const opening = new Promise((resolve) => {
    releaseSession = resolve;
  });
  const port = createCdpPageActionPort({ createCDPSession: () => opening }, stalledSpec);
  const controller = new AbortController();
  const pending = runLivePageAction(stalledActionInput(controller, port));
  setTimeout(() => controller.abort('stopped'), 10);
  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve({ status: 'timeout_after_abort' }), 450)),
  ]);
  assert.equal(result.status, 'cancelled');
  releaseSession({
    async send() {
      commandsAfterStop++;
      throw new Error('late CDP command');
    },
    async detach() {
      detached = true;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(commandsAfterStop, 0);
  assert.equal(detached, true);
});

test('stop settles a hung CDP inspection and detaches its session', async () => {
  let detached = false;
  const session = {
    on() {},
    off() {},
    async send(method) {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'fixture-frame' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
      if (method === 'Runtime.evaluate') return new Promise(() => {});
      return {};
    },
    async detach() {
      detached = true;
    },
  };
  const port = createCdpPageActionPort({ createCDPSession: async () => session }, stalledSpec);
  const controller = new AbortController();
  const pending = runLivePageAction(stalledActionInput(controller, port));
  setTimeout(() => controller.abort('stopped'), 10);
  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve({ status: 'timeout_after_abort' }), 450)),
  ]);
  assert.equal(result.status, 'cancelled');
  assert.equal(detached, true);
});

test('stop during a hung CDP perform is unknown and detaches its session', async () => {
  let detached = false;
  let evaluations = 0;
  const rawFingerprint = 'raw-target';
  const fingerprint = `sha256:${createHash('sha256').update(rawFingerprint).digest('hex')}`;
  const session = {
    on() {},
    off() {},
    async send(method) {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'fixture-frame' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
      if (method === 'Runtime.evaluate') {
        evaluations++;
        if (evaluations === 1)
          return {
            result: {
              value: {
                origin: 'http://127.0.0.1:5227',
                url: 'http://127.0.0.1:5227/',
                readback: 'empty',
                candidates: [{ id: 'note', operation: 'fill', label: 'Note', fingerprint: rawFingerprint }],
              },
            },
          };
        return new Promise(() => {});
      }
      return {};
    },
    async detach() {
      detached = true;
    },
  };
  const port = createCdpPageActionPort({ createCDPSession: async () => session }, stalledSpec);
  const controller = new AbortController();
  const pending = runLivePageAction(stalledActionInput(controller, port, fingerprint));
  setTimeout(() => controller.abort('stopped'), 20);
  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve({ status: 'timeout_after_abort' }), 450)),
  ]);
  assert.equal(result.status, 'unknown');
  assert.equal(evaluations, 2);
  assert.equal(detached, true);
});
