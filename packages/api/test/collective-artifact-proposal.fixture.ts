import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readArtifactJsonPages } from '../../collective-client/src/collective-artifact-client.js';
import type { custodyHttpFixture } from './collective-custody-http.fixture.js';

/** Real public request and owner proposal; no model execution is simulated as runtime progress. */
export async function sharedProposal(
  f: Awaited<ReturnType<typeof custodyHttpFixture>>,
  session = f.member.sessionToken,
) {
  await f.store.publishParticipation(f.targetConnection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.targetConnection.connectionId,
    revision: 1,
    agents: [{ catId: 'codex61-sol', displayName: 'Sol', channelIds: ['general'] }],
  });
  const quote = '真实正文';
  const ask = await f.store.publishArtifactRequest(session, {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    sourceEventId: f.source.eventId,
    ownerRevision: 1,
    annotationIds: [],
    selections: [
      {
        start: f.text.indexOf(quote),
        end: f.text.indexOf(quote) + quote.length,
        quoteDigest: `sha256:${createHash('sha256').update(quote).digest('hex')}`,
      },
    ],
    expectedReviewRevision: 1,
    clientEventId: 'shared-recovery-request',
    body: '请把这处说明改清楚。',
    recipient: {
      kind: 'agent',
      humanId: f.owner.human.humanId,
      connectionId: f.targetConnection.connectionId,
      agentId: 'codex61-sol',
      participationRevision: 1,
    },
  });
  const agent = {
    connectionId: f.targetConnection.connectionId,
    requestEventId: ask.source.eventId,
    catId: 'codex61-sol',
    participationRevision: 1,
  };
  const read = (await readArtifactJsonPages(async (page) => {
    const result = await f.invoke(
      f.targetConnection.endpointCredential,
      'read',
      page,
      'prepare-recovery-proposal',
      agent,
    );
    assert.equal(result.status, 200, JSON.stringify(result));
    return result.value.value;
  })) as { modification: { requestId: string } };
  const submitted = await f.invoke(
    f.targetConnection.endpointCredential,
    'propose',
    {
      kind: 'respond-modification',
      requestId: read.modification.requestId,
      operationId: '00000000-0000-4000-8000-000000000081',
      expectedOwnerRevision: 1,
      expectedProposalRevision: 0,
      baseRevision: f.artifact.versions[0].blobDigest,
      edits: [
        {
          start: f.text.indexOf(quote),
          end: f.text.indexOf(quote) + quote.length,
          expectedText: quote,
          replacement: '共享正文',
        },
      ],
      response: '说明已更清楚。',
    },
    'shared-recovery-proposal',
    agent,
  );
  assert.equal(submitted.status, 200, JSON.stringify(submitted));
  return {
    requestId: read.modification.requestId,
    proposalRef: submitted.value.value.proposal.proposalRef,
  };
}
