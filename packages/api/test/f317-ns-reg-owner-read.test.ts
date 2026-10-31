// F317 north-star regression harness, Tier A (owner read model): the card/badge data the desktop shows
// must keep its source's counts, never turn "not read" into "nothing", and never leak source internals.
// Uses the real readCompanionDecisions with a fake owner client; no network, no media.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCompanionDecisions } from '../src/domains/concierge/live/companion-decision-read.js';
import type { CompanionOwnerClient } from '../src/domains/concierge/live/companion-owner-client.js';

const page = (over: Record<string, unknown> = {}) => ({
  status: 'available',
  approvalCount: 7,
  needsMeCount: 3,
  otherNeedsMeCount: 2,
  approvals: [
    {
      proposalId: 'taste-1',
      sourceFeatureId: 'F221',
      summary: '品味提案',
      resolution: 'open',
      materialization: { state: 'not_started' },
      // internals that must never cross to the public renderer bridge
      approvalHandle: 'secret-handle',
      ownerUserId: 'owner',
      linkedNeedsMe: { envelope: { subjectRef: 'x' } },
    },
  ],
  otherNeedsMe: [
    {
      envelope: { subjectRef: 'subject:task:t1', internalRoute: 'private' },
      brief: { outcome: { value: '回看这条' }, secret: 'no' },
    },
  ],
  page: { offset: 0, limit: 5, hasMoreApprovals: true, hasMoreNeedsMe: false },
  ...over,
});

function client(respond: (path: string) => unknown) {
  const paths: string[] = [];
  const fake = {
    request: async (path: string) => {
      paths.push(path);
      const value = respond(path);
      if (value instanceof Error) throw value;
      return value;
    },
  } as unknown as CompanionOwnerClient;
  return { fake, paths };
}

test('counts are the source counts: neither the shown page length nor a sum across groups', async () => {
  const c = client(() => page());
  const reply = await readCompanionDecisions(c.fake, 0, 5);
  assert.equal(reply.kind, 'decisions');
  if (reply.kind !== 'decisions') return;
  assert.equal(reply.approvals.length, 1);
  assert.equal(reply.approvalCount, 7, 'not the page length');
  assert.equal(reply.needsMeCount, 3);
  assert.equal(reply.otherNeedsMeCount, 2);
  assert.notEqual(reply.approvalCount + reply.needsMeCount + reply.otherNeedsMeCount, reply.approvals.length);
});

test('offset and limit reach the source unchanged, and "there is more" survives the projection', async () => {
  const c = client(() => page({ page: { offset: 10, limit: 10, hasMoreApprovals: true, hasMoreNeedsMe: true } }));
  const reply = await readCompanionDecisions(c.fake, 10, 10);
  assert.deepEqual(c.paths, ['/api/concierge/work/decisions?offset=10&limit=10']);
  assert.equal(reply.kind === 'decisions' && reply.page.hasMoreApprovals, true);
  assert.equal(reply.kind === 'decisions' && reply.page.hasMoreNeedsMe, true);
  assert.equal(reply.kind === 'decisions' && reply.page.offset, 10);
});

test('a source that is not fully available is never projected as an available zero', async () => {
  for (const partial of [
    page({ status: 'partial' }),
    page({ status: 'unavailable' }),
    page({ status: 'unauthorized' }),
    page({ page: undefined }),
    page({ approvalCount: undefined }),
    { status: 'available' },
    null,
    'nope',
  ]) {
    const c = client(() => partial);
    await assert.rejects(
      readCompanionDecisions(c.fake, 0, 5),
      (error: unknown) => error instanceof Error,
      `must not fold ${JSON.stringify(partial)}`,
    );
  }
});

test('a failing source read fails the read; it does not become an empty page', async () => {
  const c = client(() => new Error('source down'));
  await assert.rejects(readCompanionDecisions(c.fake, 0, 5), /source down/);
});

test('source internals never cross the bridge: only the allow-listed fields survive', async () => {
  const c = client(() => page());
  const reply = await readCompanionDecisions(c.fake, 0, 5);
  assert.equal(reply.kind, 'decisions');
  if (reply.kind !== 'decisions') return;
  assert.deepEqual(Object.keys(reply.approvals[0]!).sort(), [
    'linkedNeedsMe',
    'materializationState',
    'proposalId',
    'resolution',
    'sourceFeatureId',
    'summary',
  ]);
  assert.equal(reply.approvals[0]!.linkedNeedsMe, true, 'the linked object is reduced to a boolean');
  assert.deepEqual(Object.keys(reply.otherNeedsMe[0]!).sort(), ['subjectRef', 'summary']);
  const wire = JSON.stringify(reply);
  for (const leaked of ['secret-handle', 'ownerUserId', 'internalRoute', '"secret"', 'private']) {
    assert.equal(wire.includes(leaked), false, `${leaked} leaked`);
  }
});

test('long summaries are clipped, and a source item that has no readable brief keeps its subject reference', async () => {
  const long = '长'.repeat(900);
  const c = client(() =>
    page({
      approvals: [
        {
          proposalId: 'p',
          sourceFeatureId: 'F221',
          summary: long,
          resolution: 'open',
          materialization: { state: 'not_started' },
        },
      ],
      otherNeedsMe: [{ envelope: { subjectRef: 'subject:task:no-brief' } }],
    }),
  );
  const reply = await readCompanionDecisions(c.fake, 0, 5);
  assert.ok(reply.kind === 'decisions');
  if (reply.kind !== 'decisions') return;
  assert.equal(reply.approvals[0]!.summary.length, 500);
  assert.equal(
    reply.otherNeedsMe[0]!.subjectRef,
    'subject:task:no-brief',
    'navigation identity survives a missing brief',
  );
});
