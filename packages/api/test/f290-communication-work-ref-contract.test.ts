import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CollectiveSourceIdentity, type CollectiveWorkMatter, createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { z } from 'zod';
import { collectiveContinueWorkInputSchema } from '../../mcp-server/src/tools/collective-participation-tools.js';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { collectiveContextError } from '../src/domains/plugin/builtin-runtime/collective-context-refs.js';
import { CollectiveCurrentContext } from '../src/domains/plugin/builtin-runtime/collective-current-context.js';
import { currentWorkSourceContext } from '../src/domains/plugin/builtin-runtime/collective-work/collective-work-source-context.js';
import { registerCollectiveParticipationCallbacks } from '../src/routes/callback-collective-participation-routes.js';

test('actual source-context signed refs survive MCP and authenticated HTTP after multi-digit Work revisions', async () => {
  const source: CollectiveSourceIdentity = {
    serviceInstanceId: 'svc_100000000000',
    collectiveId: 'col_100000000000',
    connectionId: 'con_100000000000',
    eventId: 'evt_100000000000',
    location: { channelId: 'general' },
    catId: 'codex-sol',
    participationRevision: 1,
    actor: { kind: 'human', humanId: 'human_guest00000', displayName: 'Guest' },
  };
  const registry = new InvocationRegistry();
  const credentials = await registry.create(
    'owner',
    createCatId(source.catId),
    'channel',
    undefined,
    undefined,
    { mode: 'collective_participation' },
    'source',
    'unknown',
    undefined,
    { kind: 'collective-participation', originTriggerMessageId: 'source', source },
  );
  const verified = await registry.verify(credentials.invocationId, credentials.callbackToken);
  assert.ok(verified.ok);
  const matter: CollectiveWorkMatter = {
    workId: `work_${'a'.repeat(32)}`,
    sourceEventId: source.eventId,
    sourceLocation: source.location,
    title: 'Guide',
    intendedOutcomePreview: 'Improve guide',
    revision: 12,
    executionRevision: 21,
    resultRevision: 2,
    resultEventId: `evt_${'b'.repeat(32)}`,
    lifecycle: 'result_ready',
    status: 'result_ready',
  };
  const producer = await currentWorkSourceContext(
    {
      async readWorkSourceContext() {
        return { sourceEventId: source.eventId, matters: [matter], relatedWorkIds: [matter.workId], hasMore: false };
      },
    },
    verified.record,
    { source, sourceRef: 'message:source', displayName: 'Sol' },
  );
  const workRef = producer.matters[0]?.workRef;
  assert.ok(workRef && workRef.length > 256, 'real encoder emits longer refs as revisions grow');
  const input = {
    contextRef: 'current-context',
    workRef,
    kind: 'revision',
    grantRef: 'grant-guide',
    grantRevision: 1,
    requestKind: 'guide',
  };
  assert.equal(z.object(collectiveContinueWorkInputSchema).parse(input).workRef, workRef);
  const context = new CollectiveCurrentContext({
    connector: () => undefined,
    messageStore: { getById: () => null },
    threadStore: { get: () => null },
  });
  // This is a boundary test, not an execution or permission claim: the real principal and producer feed both input consumers.
  let consumed = false;
  context.continueWork = async (_record, _ref, value) => {
    assert.equal(value.workRef, workRef);
    consumed = true;
    return {
      workId: matter.workId,
      assignmentEventId: undefined,
      executionAuthority: undefined,
      accountableHumanId: undefined,
      lifecycle: 'in_progress',
      disposition: 'accepted_pending_host_admission',
    };
  };
  const app = Fastify();
  try {
    await registerCollectiveParticipationCallbacks(app, { registry, context });
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/collective-continue-work',
      payload: input,
      headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(consumed, true);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/callbacks/collective-continue-work',
          payload: { ...input, workRef: 'x'.repeat(2001) },
          headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
        })
      ).statusCode,
      400,
    );
  } finally {
    await app.close();
  }
});

test('untrusted Collective callbacks retain domain reasons while filesystem and internal errors hide private paths', async () => {
  const registry = new InvocationRegistry();
  const credentials = await registry.create(
    'owner',
    createCatId('codex-sol'),
    'channel',
    undefined,
    undefined,
    { mode: 'collective_participation' },
    'source',
    'unknown',
    undefined,
    {
      kind: 'collective-participation',
      originTriggerMessageId: 'source',
      source: {
        serviceInstanceId: 'svc_100000000000',
        collectiveId: 'col_100000000000',
        connectionId: 'con_100000000000',
        eventId: 'evt_100000000000',
        location: { channelId: 'general' },
        catId: 'codex-sol',
        participationRevision: 1,
        actor: { kind: 'human', humanId: 'human_guest00000', displayName: 'Guest' },
      },
    },
  );
  const context = new CollectiveCurrentContext({
    connector: () => undefined,
    messageStore: { getById: () => null },
    threadStore: { get: () => null },
  });
  const app = Fastify();
  const privatePath = '/private/cafe/.cat-cafe/collective-connector.json';
  let cause: Error = Object.assign(new Error(`EACCES: ${privatePath}`), { code: 'EACCES' });
  context.current = async () => {
    throw cause;
  };
  try {
    await registerCollectiveParticipationCallbacks(app, { registry, context });
    const call = () =>
      app.inject({
        method: 'POST',
        url: '/api/callbacks/collective-current-context',
        payload: {},
        headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
      });
    const filesystem = await call();
    assert.equal(filesystem.statusCode, 409);
    assert.deepEqual(filesystem.json(), { code: 'EACCES', error: 'Collective source unavailable' });
    cause = new Error(`Internal operation failed in ${privatePath}`);
    const internal = await call();
    assert.deepEqual(internal.json(), { code: 'RETURN_UNAVAILABLE', error: 'Collective source unavailable' });
    cause = collectiveContextError('WORK_DELEGATION_UNAVAILABLE', 'Current delegation has been revoked');
    const domain = await call();
    assert.deepEqual(domain.json(), {
      code: 'WORK_DELEGATION_UNAVAILABLE',
      error: 'Current delegation has been revoked',
    });
  } finally {
    await app.close();
  }
});
