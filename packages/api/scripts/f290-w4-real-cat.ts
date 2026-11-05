/** Opt-in model dogfood. Run with with-test-home.sh; never part of deterministic CI. */
import '../test/helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { collectiveEventSourceIdentity } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { CollectiveCurrentContext } from '../src/domains/plugin/builtin-runtime/collective-current-context.js';
import { collectiveSender } from '../src/domains/plugin/builtin-runtime/collective-ingress-routing.js';
import { registerCollectiveParticipationCallbacks } from '../src/routes/callback-collective-participation-routes.js';
import { collectiveArtifactOwnerFixture } from '../test/collective-artifact-owner.fixture.js';
import { prepareRealCatTemplate, realCatId, runRealCollectiveCat } from '../test/helpers/f290-real-cat-launch.js';

assert.equal(process.env.F290_REAL_CAT, '1', 'Explicit F290_REAL_CAT=1 is required for a paid model invocation');
assert.equal(process.env.CAT_CAFE_TEST_SANDBOX, '1', 'Use with-test-home.sh for isolated data and Redis denial');
const cleanup: (() => Promise<unknown>)[] = [];
const catId = realCatId;
const registry = new InvocationRegistry();
let activeId = '';
const f = await collectiveArtifactOwnerFixture(
  { after: (fn) => cleanup.push(fn) },
  {
    verifyAgent: async (agent) => agent.catId === catId && agent.sessionRef === activeId,
  },
);
const app = Fastify();
await prepareRealCatTemplate(f.root);
let stopped = false;
const loop = (async () => {
  while (!stopped) {
    await f.connector.sync(f.connection.connectionId);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
})();
try {
  const route = await f.connector.setHostRoute(
    f.connection.connectionId,
    {
      localOwnerUserId: 'real-local-owner',
      defaultIngressThreadId: 'private-channel',
      humanNotificationThreadId: 'private-channel',
      agentRoutes: {
        [`${f.owner.human.humanId}:${catId}`]: {
          catId,
          threadId: 'private-channel',
          participation: { displayName: '砚砚', channelIds: ['general'] },
        },
      },
    },
    1,
  );
  await f.connector.publishParticipation(f.connection.connectionId);
  const quote = '真实正文';
  const start = f.text.indexOf(quote);
  const published = await f.store.publishArtifactRequest(f.member.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    sourceEventId: f.source.eventId,
    ownerRevision: 1,
    annotationIds: [],
    expectedReviewRevision: 1,
    selections: [
      { start, end: start + quote.length, quoteDigest: `sha256:${createHash('sha256').update(quote).digest('hex')}` },
    ],
    clientEventId: 'real-cat-modification-request',
    body: '请把选中的“真实正文”改成读者一看就懂的说法，保留其余内容。提交一份候选，再回原处说明；不要采用。',
    recipient: {
      kind: 'agent',
      humanId: f.owner.human.humanId,
      agentId: catId,
      connectionId: f.connection.connectionId,
      participationRevision: route.revision,
    },
  });
  const source = collectiveEventSourceIdentity(published.source);
  assert.ok(source);
  const messages = new MessageStore();
  const message = messages.append({
    userId: 'real-local-owner',
    threadId: 'private-channel',
    from: { kind: 'external', connectorId: 'collective', sender: collectiveSender(published.source) },
    content: published.source.body,
    mentions: [],
    timestamp: Date.now(),
    source: { connector: 'collective', label: 'Collective', icon: 'collective', meta: { participation: source } },
  });
  const auth = await registry.create(
    'real-local-owner',
    catId,
    'private-channel',
    undefined,
    undefined,
    { mode: 'collective_participation' },
    message.id,
    'unknown',
    undefined,
    { kind: 'collective-participation', originTriggerMessageId: message.id, source },
  );
  activeId = auth.invocationId;
  const context = new CollectiveCurrentContext({
    connector: () => f.connector,
    messageStore: messages,
    threadStore: { get: () => ({ createdBy: 'real-local-owner' }) },
  });
  const callbacks: { path: string; status: number; input?: unknown; response?: unknown }[] = [];
  const callbackResponses = new Map<string, unknown>();
  app.addHook('onSend', async (request, _reply, payload) => {
    if (typeof payload === 'string') callbackResponses.set(request.id, JSON.parse(payload));
    return payload;
  });
  app.addHook('onResponse', async (request, reply) => {
    callbacks.push({
      path: request.url,
      status: reply.statusCode,
      input: request.body,
      response: callbackResponses.get(request.id),
    });
    callbackResponses.delete(request.id);
  });
  await registerCollectiveParticipationCallbacks(app, { registry, context });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const executions = await runRealCollectiveCat({
    root: f.root,
    apiUrl: `http://127.0.0.1:${address.port}`,
    userId: 'real-local-owner',
    threadId: 'private-channel',
    auth,
    prompt:
      '处理当前 Collective 请求。先用 current-context，再用 artifact-command read 读取真实来源；读完所有页后按请求生成候选并用 respond 提交。最后 collective_reply 回原处。不要接新 Work，不要申请额外权限。',
  });
  process.stdout.write(`${JSON.stringify({ kind: 'f290.real-cat-callbacks', callbacks })}\n`);
  assert.ok(callbacks.some((call) => call.path.endsWith('collective-artifact-command') && call.status === 200));
  assert.ok(callbacks.some((call) => call.path.endsWith('collective-reply') && call.status === 200));
  const read = await f.request(f.owner.sessionToken, 'read', {}, 'real-cat-human-read');
  assert.equal(read.status, 200, JSON.stringify(read));
  const record = read.value.value.modifications.requests.find(
    (item: { requestEventId: string }) => item.requestEventId === published.source.eventId,
  );
  assert.ok(record?.latestProposalRef);
  const preview = await f.request(
    f.owner.sessionToken,
    'preview',
    {
      requestId: record.requestId,
      proposalRef: record.latestProposalRef,
    },
    'real-cat-preview',
  );
  assert.equal(preview.status, 200, JSON.stringify(preview));
  const candidate = preview.value.value;
  assert.equal(candidate.proposal.authorCatId, catId);
  assert.equal(candidate.request.requestEventId, published.source.eventId);
  assert.equal(candidate.baseText, f.text);
  assert.notEqual(candidate.proposedText, f.text);
  assert.equal((await f.contentOwner.describe(f.artifact.contentRef)).currentOwnerRevision, 1);
  const selection = { requestId: record.requestId, proposalRef: record.latestProposalRef };
  const denied = await f.request(f.member.sessionToken, 'apply', selection, 'real-cat-reader-cannot-adopt');
  assert.equal(denied.status, 403);
  const adopted = await f.request(f.owner.sessionToken, 'apply', selection, 'real-cat-human-adopt');
  assert.equal(adopted.status, 200, JSON.stringify(adopted));
  assert.equal(adopted.value.value.receipt.ownerRevision, 2);
  const version = f.store.listArtifacts(f.owner.sessionToken, f.coordinates)[0].versions.at(-1);
  assert.equal(version?.authorCatId, catId);
  assert.equal(version?.adoptedByHumanId, f.owner.human.humanId);
  const events = await f.store.listEventsForHuman(f.owner.sessionToken, f.coordinates.collectiveId);
  const returned = events.filter(
    (event) =>
      event.actor.kind === 'agent' &&
      event.actor.provenance.catId === catId &&
      event.actor.provenance.sessionRef === activeId,
  );
  assert.equal(returned.length, 1);
  assert.equal(returned[0]?.location?.rootEventId, f.source.eventId);
  process.stdout.write(
    `${JSON.stringify({
      kind: 'f290.real-cat-candidate',
      catId,
      executions,
      callbacks: callbacks.map(({ path, status }) => ({ path, status })),
      requestEventId: published.source.eventId,
      replyEventId: returned[0]?.eventId,
      proposal: {
        authorCatId: candidate.proposal.authorCatId,
        baseText: candidate.baseText,
        proposedText: candidate.proposedText,
        receiptRef: candidate.proposal.receiptRef,
      },
      beforeHumanAdoption: 1,
      afterHumanAdoption: version?.ownerRevision,
      readonlyHumanAdoptionStatus: denied.status,
    })}\n`,
  );
} finally {
  stopped = true;
  await loop;
  await f.connector.stopMediaReads();
  await app.close();
  for (const close of cleanup.reverse()) await close();
}
