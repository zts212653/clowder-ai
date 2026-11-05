/**
 * F202 W2-3 h3c-2 — the Remote MCP return path recognizes the configured cloud cat, whatever its id,
 * and nothing else (ledger「h3c 实现设计」h3c-2; astra's design reviews …000181 / …000188).
 *
 * A cloud cat here is `cloud-alt`, not `gpt-pro`. Its source-bound return is authorized only by the
 * server grant for that exact thread, user, source and cat. A cloud credential whose cat is no longer
 * the configured cloud cat — renamed, moved to another provider, or made ambiguous — is refused on
 * every route: it never falls through to the ordinary agent-key path (negative case 1).
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { CLOUD_CONFIG, configureCats, cloudReturnHarness as harness } from './helpers/cloud-return-harness.js';

const REFUSED = 'cloud_principal_not_configured';

beforeEach(() => configureCats(['cloud-alt']));

function assertRefused(response) {
  assert.equal(response.statusCode, 403, response.body);
  assert.equal(response.json().reason, REFUSED);
}

test('the configured cloud cat, whatever its id, passes the auth probe; ordinary and former cloud keys do not', async () => {
  const h = await harness();
  const cloud = await h.agentKeyRegistry.issue('cloud-alt', 'alice', { scope: 'cloud-conversation' });
  const ordinary = await h.agentKeyRegistry.issue('codex', 'alice');
  const formerCloud = await h.agentKeyRegistry.issue('gpt-pro', 'alice', { scope: 'cloud-conversation' });
  const otherUser = await h.agentKeyRegistry.issue('cloud-alt', 'mallory', { scope: 'cloud-conversation' });

  assert.deepEqual((await h.probe(cloud.secret)).json(), { ok: true });
  assert.deepEqual((await h.probe(ordinary.secret)).json(), { ok: false, reason: 'cloud_principal_required' });
  assert.deepEqual((await h.probe(otherUser.secret)).json(), { ok: false, reason: 'cloud_principal_required' });
  assertRefused(await h.probe(formerCloud.secret));
  await h.app.close();
});

test('a non-gpt-pro cloud cat returns once to its exact source, through its server grant', async () => {
  const h = await harness();
  const cloud = await h.agentKeyRegistry.issue('cloud-alt', 'alice', { scope: 'cloud-conversation' });
  await h.grant('cloud-alt');

  const first = await h.post(cloud.secret, { content: 'the answer', replyTo: h.source.id });
  assert.equal(first.statusCode, 200, first.body);
  const [stored, ...others] = await h.repliesTo(h.source.id);
  assert.equal(others.length, 0);
  assert.equal(stored.catId, 'cloud-alt');
  assert.deepEqual(await h.grantStore.claim(h.scope('cloud-alt')), { ok: false, reason: 'consumed' });

  const retry = await h.post(cloud.secret, { content: 'the answer, regenerated', replyTo: h.source.id });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().status, 'duplicate');
  assert.equal(retry.json().messageId, stored.id, 'the exact source gets one message, whatever the retry says');
  assert.equal((await h.repliesTo(h.source.id)).length, 1);
  await h.app.close();
});

test('the wrong cat, source or thread, or no grant at all, is refused', async () => {
  const h = await harness();
  const cloud = await h.agentKeyRegistry.issue('cloud-alt', 'alice', { scope: 'cloud-conversation' });
  await h.grant('gpt-pro');

  const wrongCat = await h.post(cloud.secret, { content: 'x', replyTo: h.source.id });
  assert.equal(wrongCat.statusCode, 403, wrongCat.body);
  assert.equal(wrongCat.json().kind, 'cloud_return_grant_not_found', 'a grant for another cat authorizes nothing');

  // A source answers to one cloud cat: this one is gpt-pro's, so cloud-alt's grant goes on another.
  const granted = h.append('granted to cloud-alt');
  await h.grant('cloud-alt', granted.id);
  const noGrant = await h.post(cloud.secret, { content: 'x', replyTo: h.unGranted.id });
  assert.equal(noGrant.statusCode, 403, noGrant.body);
  assert.equal(noGrant.json().kind, 'cloud_return_grant_not_found');

  const wrongThread = await h.post(cloud.secret, { content: 'x', replyTo: granted.id, threadId: h.otherThread.id });
  assert.equal(wrongThread.statusCode, 403, wrongThread.body);
  assert.equal(wrongThread.json().kind, 'cloud_return_source_ineligible');

  const unknownSource = await h.post(cloud.secret, { content: 'x', replyTo: 'no-such-message' });
  assert.equal(unknownSource.json().kind, 'cloud_return_source_ineligible');
  assert.equal((await h.posted('x')).length, 0);
  assert.equal(
    (await h.grantStore.claim(h.scope('cloud-alt', granted.id))).ok,
    true,
    'the refusals left the grant unused',
  );
  await h.app.close();
});

test('a user-bound key of the configured cloud cat is refused: only a cloud-scoped key speaks for it', async () => {
  const h = await harness();
  const userBound = await h.agentKeyRegistry.issue('cloud-alt', 'alice');

  assertRefused(await h.probe(userBound.secret));
  assertRefused(await h.post(userBound.secret, { content: 'x', replyTo: h.unGranted.id }));
  assertRefused(await h.post(userBound.secret, { content: 'x' }));
  assertRefused(await h.readContext(userBound.secret));
  assert.equal((await h.posted('x')).length, 0);
  await h.app.close();
});

test('P1-1: a cloud key authenticated before a rename is refused where the route uses it, never posted as ordinary', async () => {
  const h = await harness();
  const cloud = await h.agentKeyRegistry.issue('cloud-alt', 'alice', { scope: 'cloud-conversation' });

  for (const payload of [{ content: 'no grant', replyTo: h.unGranted.id }, { content: 'proactive' }]) {
    configureCats(['cloud-alt']);
    h.onNextThreadRead(() => configureCats(['cloud-beta']));
    assertRefused(await h.post(cloud.secret, payload));
  }
  assert.equal((await h.posted('no grant')).length + (await h.posted('proactive')).length, 0);
  await h.app.close();
});

test('P1-1: an ordinary key whose cat becomes the cloud cat mid-request is refused as well', async () => {
  const h = await harness();
  const ordinary = await h.agentKeyRegistry.issue('codex', 'alice');

  h.onNextThreadRead(() => configureCats(['codex']));
  assertRefused(await h.post(ordinary.secret, { content: 'switched' }));
  assert.equal((await h.posted('switched')).length, 0);

  configureCats(['cloud-alt']);
  const unchanged = await h.post(ordinary.secret, { content: 'still ordinary' });
  assert.equal(unchanged.statusCode, 200, 'without a change the ordinary key posts as before');
  await h.app.close();
});

test('negative case 1: a cloud key outlives its cat being renamed — and is refused everywhere, not demoted', async () => {
  const h = await harness();
  const cloud = await h.agentKeyRegistry.issue('cloud-alt', 'alice', { scope: 'cloud-conversation' });
  await h.grant('cloud-alt');
  assert.equal((await h.readContext(cloud.secret)).statusCode, 200, 'the cloud cat reads its thread');

  configureCats(['cloud-beta']);
  assertRefused(await h.post(cloud.secret, { content: 'proactive' }));
  assertRefused(await h.post(cloud.secret, { content: 'bound', replyTo: h.source.id }));
  assertRefused(await h.probe(cloud.secret));
  assertRefused(await h.readContext(cloud.secret));
  assert.equal((await h.posted('proactive')).length + (await h.posted('bound')).length, 0);
  assert.equal((await h.grantStore.claim(h.scope('cloud-alt'))).ok, true, 'the in-flight grant was not touched');
  await h.app.close();
});

test('negative case 1: a cloud key whose cat moved to another provider is refused as well', async () => {
  configureCats([], { 'cloud-alt': { ...CLOUD_CONFIG, id: 'cloud-alt', provider: 'openai' } });
  const h = await harness();
  const cloud = await h.agentKeyRegistry.issue('cloud-alt', 'alice', { scope: 'cloud-conversation' });

  assertRefused(await h.post(cloud.secret, { content: 'proactive' }));
  assertRefused(await h.readContext(cloud.secret));
  const ordinary = await h.agentKeyRegistry.issue('cloud-alt', 'alice');
  assert.equal((await h.readContext(ordinary.secret)).statusCode, 200, "the cat's ordinary keys are its own business");
  await h.app.close();
});

test('while the provider is ambiguous, no key of its cats is honoured, scoped or not', async () => {
  configureCats(['cloud-alt', 'cloud-beta']);
  const h = await harness();
  const cloud = await h.agentKeyRegistry.issue('cloud-alt', 'alice', { scope: 'cloud-conversation' });
  const legacy = await h.agentKeyRegistry.issue('cloud-beta', 'alice');

  assertRefused(await h.post(cloud.secret, { content: 'proactive' }));
  assertRefused(await h.post(legacy.secret, { content: 'proactive' }));
  assertRefused(await h.probe(legacy.secret));
  const codex = await h.agentKeyRegistry.issue('codex', 'alice');
  assert.equal((await h.readContext(codex.secret)).statusCode, 200, 'only this provider is affected');
  await h.app.close();
});
