import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CollectiveSourceIdentity, type CollectiveWorkMatter, createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { z } from 'zod';
import { collectiveContinueWorkInputSchema } from '../../mcp-server/src/tools/collective-participation-tools.js';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { collectiveContextError } from '../src/domains/plugin/builtin-runtime/collective-context-refs.js';
import { CollectiveCurrentContext } from '../src/domains/plugin/builtin-runtime/collective-current-context.js';
import {
  currentWorkSourceContext,
  suggestProjectWorkFromSource,
} from '../src/domains/plugin/builtin-runtime/collective-work/collective-work-source-context.js';
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
    projectContext: {
      projects: [],
      unreadableProjectCount: 0,
      projectsHasMore: false,
      dependencies: [],
      unreadableDependencyCount: 0,
      dependenciesHasMore: false,
    },
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

test('signed Project refs create only a pending candidate and fail closed after Project or target drift', async () => {
  const source: CollectiveSourceIdentity = {
    serviceInstanceId: 'svc_200000000000',
    collectiveId: 'col_200000000000',
    connectionId: 'con_200000000000',
    eventId: 'evt_200000000000',
    location: { channelId: 'general' },
    catId: 'codex-sol',
    participationRevision: 3,
    actor: { kind: 'human', humanId: 'human_guest00001', displayName: 'Guest' },
  };
  const registry = new InvocationRegistry();
  const credentials = await registry.create(
    'owner',
    createCatId(source.catId),
    'channel',
    undefined,
    undefined,
    { mode: 'collective_participation' },
    'project-source',
    'unknown',
    undefined,
    { kind: 'collective-participation', originTriggerMessageId: 'project-source', source },
  );
  const verified = await registry.verify(credentials.invocationId, credentials.callbackToken);
  assert.ok(verified.ok);
  const project = {
    roadmapId: `roadmap_${'p'.repeat(12)}`,
    sourceEventId: `evt_${'r'.repeat(12)}`,
    sourceLocation: { channelId: 'general' },
    title: '正式交付',
    purpose: '把真实结果接回原项目。',
    status: 'active' as const,
    revision: 7,
  };
  let matter: CollectiveWorkMatter = {
    workId: `work_${'c'.repeat(32)}`,
    sourceEventId: source.eventId,
    sourceLocation: source.location,
    title: '现有任务',
    intendedOutcomePreview: '交付现有任务',
    revision: 14,
    lifecycle: 'committed',
    status: 'ready',
    projectContext: {
      projects: [project],
      unreadableProjectCount: 0,
      projectsHasMore: false,
      dependencies: [],
      unreadableDependencyCount: 0,
      dependenciesHasMore: false,
    },
  };
  let proposal: Record<string, unknown> | undefined;
  const connector = {
    async readWorkSourceContext() {
      return { sourceEventId: source.eventId, matters: [matter], relatedWorkIds: [matter.workId], hasMore: false };
    },
    async proposeWork(_source: unknown, _requestId: string, _agent: unknown, input: Record<string, unknown>) {
      proposal = input;
      return {
        workId: `work_${'d'.repeat(32)}`,
        revision: 1,
        lifecycle: 'proposed',
        projectSuggestion: input.projectSuggestion,
      };
    },
  };
  const binding = { source, sourceRef: 'message:project-source', displayName: 'Sol' };
  const projected = await currentWorkSourceContext(connector, verified.record, binding);
  const projectedMatter = projected.matters[0];
  const projectRef = projectedMatter?.projectContext.projects[0]?.projectRef;
  assert.ok(projectRef && projectedMatter?.workRef);
  const result = await suggestProjectWorkFromSource(connector as never, verified.record, binding, {
    projectRef,
    prerequisiteForWorkRef: projectedMatter.workRef,
    title: '补一项真实前置',
    intendedOutcome: '前置完成且有可验收结果。',
  });
  assert.equal(result.disposition, 'pending_human_decision');
  assert.deepEqual(proposal?.projectSuggestion, {
    roadmapId: project.roadmapId,
    roadmapRevision: project.revision,
    prerequisiteForWorkId: matter.workId,
    prerequisiteForWorkRevision: matter.revision,
  });

  matter = {
    ...matter,
    projectContext: { ...matter.projectContext, projects: [{ ...project, revision: project.revision + 1 }] },
  };
  await assert.rejects(
    suggestProjectWorkFromSource(connector as never, verified.record, binding, {
      projectRef,
      prerequisiteForWorkRef: projectedMatter.workRef,
      title: '过期候选',
      intendedOutcome: '不能写入。',
    }),
    { code: 'WORK_REVISION_CONFLICT' },
  );
  await assert.rejects(
    suggestProjectWorkFromSource(connector as never, verified.record, binding, {
      projectRef: `${projectRef.slice(0, -1)}x`,
      title: '篡改候选',
      intendedOutcome: '不能写入。',
    }),
    { code: 'RETURN_REF_INVALID' },
  );
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
