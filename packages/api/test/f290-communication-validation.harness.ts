/**
 * F290 communication validation harness (Task495 independent validation).
 *
 * Production components: CollectiveServiceStore + startCollectiveServer (real HTTP, real disk state),
 * one real CollectiveConnector per Café (real private persistence, inbox/outbox, participation),
 * and the production Cat verifier `createCollectiveAgentVerifier`.
 *
 * Fixtures, stated explicitly so no result is over-claimed:
 *  - Human login: a fixture GitHub provider. These are NOT real GitHub Humans.
 *  - "Cat turns": an in-memory running-turn map behind the production verifier. These are NOT real model
 *    invocations; a fixture Cat is only a caller that holds a `running` turn record.
 *  - Nothing here starts a Host process, a queue processor or a model.
 *
 * Files are named so the `test:collective-communication` glob (`f290-communication-*.test.ts`) collects the
 * tests but not this harness.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollectiveConnector } from '@cat-cafe/collective-connector';
import {
  CollectiveServiceStore,
  type RunningCollectiveServer,
  startCollectiveServer,
} from '@cat-cafe/collective-service';
import { type CollectiveEventEnvelope, collectiveEventSourceIdentity } from '@cat-cafe/shared';
import { createCollectiveAgentVerifier } from '../src/domains/plugin/builtin-runtime/collective-agent-verifier.js';

export const HOST_ORIGIN = 'http://localhost:5172';
export const CHANNEL = 'general';

const displayNames: Record<string, string> = { 'codex-sol': 'Sol', 'codex-terra': 'Terra' };

type TurnStatus = 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted';

export interface Cafe {
  readonly label: string;
  /** The Host-local owner user of this Café (strict local owner path). */
  readonly ownerUserId: string;
  readonly humanId: string;
  readonly sessionToken: string;
  readonly dataDirectory: string;
  connector: CollectiveConnector;
  readonly connectionId: string;
  readonly endpointId: string;
}

export type Coordinates = { serviceInstanceId: string; collectiveId: string };

/** Real Service + real HTTP + real Connectors; `restartService`/`restartConnector` reopen from disk. */
export async function createWorld(options: { now?: () => number } = {}) {
  type Fault = { path: string; when: 'before' | 'after' };
  const faults: Fault[] = [];
  /**
   * One-shot transport faults. `after` lets the Service commit and then loses the response; `before` fails without
   * reaching it. The error is a plain fetch failure (no errno), like a reset or an opaque proxy failure.
   */
  const faultyFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const pathname = new URL(url).pathname;
    const index = faults.findIndex((fault) => fault.path === pathname);
    const fault = index >= 0 ? faults[index] : undefined;
    if (fault) faults.splice(index, 1);
    if (fault?.when === 'before') throw new TypeError('fetch failed: connection reset');
    const response = await fetch(input, init);
    if (fault?.when === 'after') throw new TypeError('fetch failed: response lost after the Service committed');
    return response;
  };
  const directories: string[] = [];
  const temp = async (prefix: string) => {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
  };
  const turns = new Map<string, { catId: string; status: TurnStatus }>();
  const verifyAgent = createCollectiveAgentVerifier({
    resolveCatDisplayName: (catId) => displayNames[catId],
    readTurnExecution: (invocationId) => turns.get(invocationId),
  });
  const humanAuthProvider = {
    id: 'github' as const,
    readiness: { ready: true as const },
    authorizationUrl: ({ state }: { state: string }) =>
      `https://github.test/authorize?state=${encodeURIComponent(state)}`,
    authenticate: async ({ code }: { code: string }) => ({ providerSubject: code, handle: code, displayName: code }),
  };
  const serviceDirectory = await temp('f290v-service-');
  const opened = await CollectiveServiceStore.open({
    dataDirectory: serviceDirectory,
    humanAuthProvider,
    now: options.now,
  });
  let store = opened.store;
  if (!opened.bootstrapSecret) throw new Error('Expected a fresh Service');
  const owner = await store.consumeBootstrap({ secret: opened.bootstrapSecret, displayName: 'You' });
  const attempt = await store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'bind' },
    sessionToken: owner.sessionToken,
  });
  const completion = await store.completeHumanAuth({ provider: 'github', state: attempt.state, code: 'operator' });
  await store.exchangeHumanAuthCompletion(completion.completionToken);
  const collective = await store.createCollective({ sessionToken: owner.sessionToken, name: 'F290 validation' });
  const coordinates: Coordinates = {
    serviceInstanceId: store.serviceInstanceId,
    collectiveId: collective.collectiveId,
  };
  let server: RunningCollectiveServer = await startCollectiveServer({
    store,
    host: '127.0.0.1',
    port: 0,
    allowedHostOrigins: [HOST_ORIGIN],
  });
  const port = server.port;

  const invite = await store.createInvite({ sessionToken: owner.sessionToken, collectiveId: collective.collectiveId });
  const memberAttempt = await store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
  });
  const memberCompletion = await store.completeHumanAuth({
    provider: 'github',
    state: memberAttempt.state,
    code: 'wulang',
  });
  const member = await store.exchangeHumanAuthCompletion(memberCompletion.completionToken);

  const pairCafe = async (label: string, human: { humanId: string }, sessionToken: string): Promise<Cafe> => {
    const dataDirectory = await temp(`f290v-connector-${label}-`);
    const connector = await CollectiveConnector.open({
      dataDirectory,
      verifyAgent,
      fetchImpl: faultyFetch,
      now: options.now,
    });
    const intent = await store.createPairingIntent({
      sessionToken,
      collectiveId: collective.collectiveId,
      hostOrigin: HOST_ORIGIN,
      nonce: `f290v-${label}-${randomUUID()}`,
    });
    const connection = await connector.pair({ serviceUrl: server.url, intent, endpointLabel: `${label} Café` });
    if (connection.authorizedHumanId !== human.humanId) throw new Error('Connection is not bound to its Human');
    return {
      label,
      ownerUserId: `owner-${label}`,
      humanId: human.humanId,
      sessionToken,
      dataDirectory,
      connector,
      connectionId: connection.connectionId,
      endpointId: connection.endpointId,
    };
  };
  const operator = await pairCafe('operator', owner.human, owner.sessionToken);
  const wulang = await pairCafe('wulang', member.human, member.sessionToken);

  const world = {
    coordinates,
    operator,
    wulang,
    get store() {
      return store;
    },
    get serviceUrl() {
      return server.url;
    },
    turns,
    /** A fixture Cat turn: the production verifier accepts a Cat action only inside a `running` turn. */
    startTurn(catId: string): string {
      const sessionRef = `invocation:${randomUUID()}`;
      turns.set(sessionRef, { catId, status: 'running' });
      return sessionRef;
    },
    endTurn(sessionRef: string, status: TurnStatus = 'succeeded') {
      const turn = turns.get(sessionRef);
      if (turn) turn.status = status;
    },
    agent(catId: string, sessionRef: string) {
      return { agentId: catId, catId, displayName: displayNames[catId] ?? catId, sessionRef };
    },
    /** Declares the Café's public Cats (Host route + Service participation). Returns the published revision. */
    async declareCats(
      cafe: Cafe,
      catIds: readonly string[],
      options: {
        threadId?: string;
        /** Legacy Host-side standing scope (owner opt-in written into the route). */
        standingWork?: { requestingHumanIds: string[]; channelIds: string[]; expiresAt: string | null };
      } = {},
    ) {
      const current = await cafe.connector.getHostRoute(cafe.connectionId);
      const agentRoutes = Object.fromEntries(
        catIds.map((catId) => [
          `${cafe.humanId}:${catId}`,
          {
            catId,
            threadId: options.threadId ?? 'public',
            participation: { displayName: displayNames[catId] ?? catId, channelIds: [CHANNEL] },
            ...(options.standingWork ? { standingWork: options.standingWork } : {}),
          },
        ]),
      );
      const route = await cafe.connector.setHostRoute(
        cafe.connectionId,
        {
          localOwnerUserId: cafe.ownerUserId,
          defaultIngressThreadId: options.threadId ?? 'public',
          humanNotificationThreadId: options.threadId ?? 'public',
          agentRoutes,
        },
        current?.revision ?? 0,
      );
      await cafe.connector.publishParticipation(cafe.connectionId);
      return route.revision;
    },
    /** The endpoint credential is private Connector state; reading it is a test-only reach-in. */
    async endpointCredential(cafe: Cafe): Promise<string> {
      const raw = JSON.parse(await readFile(join(cafe.dataDirectory, 'collective-connector.json'), 'utf8'));
      const credential = raw.connections?.[cafe.connectionId]?.endpointCredential;
      if (typeof credential !== 'string') throw new Error('Connector has no endpoint credential');
      return credential;
    },
    injectFault(fault: Fault) {
      faults.push(fault);
    },
    loseNextAcceptResponse() {
      faults.push({ path: '/api/collaboration/work/accept-agent', when: 'after' });
    },
    async stopService() {
      await server.close();
    },
    async startService() {
      const reopened = await CollectiveServiceStore.open({
        dataDirectory: serviceDirectory,
        humanAuthProvider,
        now: options.now,
      });
      store = reopened.store;
      server = await startCollectiveServer({ store, host: '127.0.0.1', port, allowedHostOrigins: [HOST_ORIGIN] });
    },
    async restartService() {
      await world.stopService();
      await world.startService();
    },
    async restartConnector(cafe: Cafe) {
      cafe.connector = await CollectiveConnector.open({
        dataDirectory: cafe.dataDirectory,
        verifyAgent,
        fetchImpl: faultyFetch,
        now: options.now,
      });
    },
    async syncAll() {
      await operator.connector.sync(operator.connectionId);
      await wulang.connector.sync(wulang.connectionId);
    },
    async close() {
      await server.close();
      await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
    },
  };
  return world;
}

export type World = Awaited<ReturnType<typeof createWorld>>;

/** A natural, un-flagged request addressed to a Café's Cat. */
export async function postNaturalRequest(
  world: World,
  from: { sessionToken: string },
  to: Cafe,
  catId: string,
  body: string,
  participationRevision: number,
  clientEventId = `request-${randomUUID()}`,
) {
  return world.store.postHumanMessage(from.sessionToken, {
    ...world.coordinates,
    clientEventId,
    location: { channelId: CHANNEL },
    target: { kind: 'agent', humanId: to.humanId, agentId: catId },
    recipient: {
      kind: 'agent',
      humanId: to.humanId,
      connectionId: to.connectionId,
      agentId: catId,
      participationRevision,
    },
    body,
  });
}

export function ownerPolicy(
  world: World,
  cafe: Cafe,
  overrides: { expectedRevision?: number; requestId?: string; grants?: readonly Record<string, unknown>[] } = {},
) {
  return {
    ...world.coordinates,
    connectionId: cafe.connectionId,
    expectedRevision: overrides.expectedRevision ?? 0,
    requestId: overrides.requestId ?? `owner-policy-${randomUUID()}`,
    decisionMode: 'automatic',
    grants: overrides.grants ?? [
      {
        grantRef: 'grant-guides',
        catIds: ['codex-sol'],
        channelIds: [CHANNEL],
        requestingHumanIds: 'channel_members',
        requestKinds: ['guide'],
        expiresAt: null,
      },
    ],
  };
}

/** Owner registers a delegation on the Service (Human session); the Host then adopts that exact revision (strict local owner). */
export async function grantAndAdopt(
  world: World,
  cafe: Cafe,
  overrides: { requestId?: string; grants?: readonly Record<string, unknown>[] } = {},
) {
  const current = await cafe.connector.readWorkPolicy(cafe.connectionId);
  const policy = await world.store.registerCollectiveWorkPolicy(
    cafe.sessionToken,
    ownerPolicy(world, cafe, { expectedRevision: current?.revision ?? 0, ...overrides }),
  );
  await cafe.connector.adoptWorkPolicy(cafe.connectionId, cafe.ownerUserId, policy.revision);
  return policy;
}

export async function grantRevisionOf(cafe: Cafe, grantRef = 'grant-guides') {
  const policy = await cafe.connector.readWorkPolicy(cafe.connectionId);
  const grant = policy?.grants.find((candidate) => candidate.grantRef === grantRef);
  assert.ok(grant, `grant ${grantRef} is registered`);
  return grant.grantRevision;
}

// ---------------------------------------------------------------------------------------------------------------
// Shared flow helpers (production Service + Connector calls; the Cat is a fixture caller inside a running turn).
// ---------------------------------------------------------------------------------------------------------------

export type NaturalRequest = CollectiveEventEnvelope;

/** The real Cat (a fixture running turn) accepts through the Connector: verifyAgent + adopted grant + durable operation. */
export async function catAccepts(
  world: World,
  cafe: Cafe,
  request: NaturalRequest,
  overrides: Record<string, unknown> = {},
) {
  const source = collectiveEventSourceIdentity(request);
  assert.ok(source, 'the request is addressed to a Cat');
  const turn = world.startTurn(source.catId);
  return cafe.connector.acceptWork(source, world.agent(source.catId, turn), {
    grantRef: 'grant-guides',
    grantRevision: (overrides.grantRevision as number | undefined) ?? (await grantRevisionOf(cafe)),
    requestKind: 'guide',
    title: 'Newcomer guide',
    intendedOutcome: request.body,
    ...overrides,
  });
}

/**
 * L1 stand-in for the Host admission fact: the production Connector API that the Host module calls.
 * (L2 / the Host suite use the production CollectiveWorkAdmission instead.)
 */
export async function admitWork(world: World, cafe: Cafe, accepted: Awaited<ReturnType<typeof catAccepts>>) {
  assert.ok(accepted.assignmentEventId && accepted.acceptance);
  await cafe.connector.recordHostAdmission(cafe.connectionId, {
    workId: accepted.workId,
    assignmentEventId: accepted.assignmentEventId,
    operationRef: accepted.acceptance.operationRef,
    grantRef: accepted.acceptance.grantRef,
    grantRevision: accepted.acceptance.grantRevision,
    disposition: {
      state: 'admitted',
      receiptRef: `host-admission:l1-${world.coordinates.collectiveId}-${accepted.workId}`,
    },
  });
}

export async function acceptNaturally(
  world: World,
  request: NaturalRequest,
  options: { overrides?: Record<string, unknown>; admit?: boolean } = {},
) {
  const accepted = await catAccepts(world, world.operator, request, options.overrides);
  await world.syncAll();
  const item = (await world.operator.connector.listInbox(world.operator.connectionId)).find(
    (candidate) => candidate.event.eventId === accepted.assignmentEventId,
  );
  assert.ok(item, 'assignment reached the accepting Café');
  const source = collectiveEventSourceIdentity(item.event);
  assert.ok(source);
  if (options.admit !== false) await admitWork(world, world.operator, accepted);
  return { accepted, source };
}

/** The accepting Café's Cat returns one result revision through the real outbox. */
export async function returnResult(
  world: World,
  source: NonNullable<ReturnType<typeof collectiveEventSourceIdentity>>,
  workKey: string,
  resultRevision: number,
  body: string,
) {
  const sourceRef = `message:host-${workKey}`;
  const resultKey = `work:${workKey}`;
  const operation = await world.operator.connector.prepareReply(source, sourceRef, resultKey, 1, resultRevision);
  const turn = world.startTurn('codex-sol');
  await world.operator.connector.submitReply(
    source,
    sourceRef,
    resultKey,
    operation.outboxId,
    body,
    world.agent('codex-sol', turn),
    undefined,
    resultRevision,
  );
  return world.operator.connector.sync(world.operator.connectionId);
}

export function workOf(world: World, workId: string) {
  const work = world.store
    .listCollectiveCollaboration(world.operator.sessionToken, world.coordinates.collectiveId)
    .works.find((candidate) => candidate.workId === workId);
  assert.ok(work, `Work ${workId} exists`);
  return work;
}

export async function landyRequestsRevision(world: World, workId: string, feedback: string, requestId: string) {
  const work = workOf(world, workId);
  return world.store.requestCollectiveWorkRevision(world.operator.sessionToken, {
    ...world.coordinates,
    requestId,
    workId,
    expectedRevision: work.revision,
    resultEventId: work.resultEventId,
    resultRevision: work.resultRevision ?? 1,
    feedback,
  });
}

/** Wulang asks You's Cat; You's owner delegates; the Cat accepts; the Host admission fact is recorded. */
export async function inFlightWork(world: World) {
  const revision = await world.declareCats(world.operator, ['codex-sol']);
  await world.declareCats(world.wulang, ['codex-sol']);
  await grantAndAdopt(world, world.operator);
  const request = await postNaturalRequest(
    world,
    world.wulang,
    world.operator,
    'codex-sol',
    'Write the guide.',
    revision,
  );
  return acceptNaturally(world, request);
}
