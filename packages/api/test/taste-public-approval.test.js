import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { F221ApprovalAdapter } from '../dist/domains/approval-hub/adapters/F221ApprovalAdapter.js';
import { tasteDecisionSnapshot } from '../dist/domains/taste/services/taste-decision-snapshot.js';
import { tasteAdmissionFixture, tasteDraft } from './helpers/taste-admission-fixture.js';

describe('Taste owner approval binds the complete house-public candidate', () => {
  let f;
  let writes;
  let headers;
  let source;
  let proposal;
  let digest;
  let writer;
  beforeEach(async () => {
    writes = [];
    writer = async (value) => {
      writes.push(value);
      return { slug: 'test', path: 'docs/taste/vignettes/test.md' };
    };
    f = await tasteAdmissionFixture({ writeVignette: (value) => writer(value) });
    const origin = 'http://localhost:3003';
    const session = await f.app.inject({ method: 'GET', url: '/api/session', headers: { origin } });
    headers = {
      origin,
      cookie: session.headers['set-cookie'].split(';', 1)[0],
      'x-csrf-token': session.json().csrfToken,
    };
    source = await f.source();
    const created = await f.propose(source, {
      ...tasteDraft,
      privacy: 'public',
      scene: `${'完整场景。'.repeat(45)}不能隐藏的最后一句`,
    });
    assert.equal(created.statusCode, 200, created.body);
    proposal = f.store.get(created.json().proposalId);
    digest = tasteDecisionSnapshot(proposal).digest;
  });
  afterEach(async () => {
    await f.app.close();
  });
  const approve = (body = { decisionDigest: digest }, extraHeaders = headers) =>
    f.app.inject({
      method: 'POST',
      url: `/api/taste-proposals/${proposal.id}/approve`,
      headers: extraHeaders,
      payload: body,
    });

  it('exposes the same complete candidate and digest to the original approval surface', async () => {
    const [item] = await new F221ApprovalAdapter(f.store).listPending('alice');
    assert.equal(item.detail.scene, proposal.scene);
    assert.equal(item.detail.decisionDigest, digest);
    const card = await f.messages.getById(proposal.publication.envelope.approvalCardRef.messageId);
    assert.ok(card.extra.rich.blocks[0].bodyMarkdown.includes('不能隐藏的最后一句'));
    assert.equal(writes.length, 0, 'pending is not permission to publish');
  });

  it('requires the owner browser decision for the exact displayed fields', async () => {
    const without = await approve({});
    assert.equal(without.statusCode, 409, without.body);
    assert.equal(without.json().code, 'decision_changed');
    const wrong = await approve({ decisionDigest: '0'.repeat(64) });
    assert.equal(wrong.statusCode, 409, wrong.body);
    const headerOnly = await approve({ decisionDigest: digest }, { 'x-cat-cafe-user': 'alice' });
    assert.ok([401, 403].includes(headerOnly.statusCode), headerOnly.body);
    assert.equal(writes.length, 0);
    const accepted = await approve();
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].decisionDigest, digest, 'the claimed proposal must retain the exact approval binding');
    assert.equal(writes[0].approvedBy, 'alice');
    assert.equal(f.store.get(proposal.id).decisionDigest, digest);
  });

  it('refuses publication after the original owner source is withdrawn', async () => {
    await f.messages.softDelete(source.id, 'alice');
    const response = await approve();
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, 'origin_not_eligible');
    assert.equal(f.store.get(proposal.id).status, 'pending');
    assert.equal(writes.length, 0);
  });

  it('refuses inconsistent original-message coordinates even when both messages belong to the owner', async () => {
    const other = await f.source();
    const stored = Reflect.get(f.store, 'proposals').get(proposal.id);
    stored.sourceMessageId = other.id;
    stored.approvalOriginRef = { kind: 'message', threadId: proposal.threadId, messageId: other.id };
    // The original persisted card envelope still points at the first source.
    const response = await approve({ decisionDigest: tasteDecisionSnapshot(f.store.get(proposal.id)).digest });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, 'origin_not_eligible');
    assert.equal(writes.length, 0);
  });

  it('retains its proof after an uncertain write, and rejects later changed content', async () => {
    writer = async () => {
      throw Object.assign(new Error('push outcome unknown'), { publicationOutcome: 'indeterminate' });
    };
    const first = await approve();
    assert.equal(first.statusCode, 500, first.body);
    const stored = f.store.get(proposal.id);
    assert.equal(stored.status, 'approving');
    assert.equal(stored.decisionDigest, digest);
    writer = async (value) => {
      writes.push(value);
      return { slug: 'test', path: 'docs/taste/vignettes/test.md' };
    };
    const wrong = await approve({ decisionDigest: 'f'.repeat(64) });
    assert.equal(wrong.statusCode, 409, wrong.body);
    assert.equal(writes.length, 0);
    const resumed = await approve();
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(resumed.json().recovered, true);
    assert.equal(writes.length, 1);
    const replay = await approve();
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(writes.length, 1);
  });
});
