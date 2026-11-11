import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import {
  _resetCachedConfig,
  getDefaultCatId,
  getRoster,
  hasRuntimeDefaultCatOverride,
  loadCatConfig,
  setRuntimeDefaultCatId,
} from '../dist/config/cat-config-loader.js';
import { resolveCatTarget } from '../dist/domains/cats/services/agents/routing/cat-target-resolver.js';
import { createActorResolver } from '../dist/infrastructure/scheduler/ActorResolver.js';
import { successorFixture } from './helpers/successor-routing-fixture.js';

it('explicit disabled mention warns with canonical successor first, without redirect or participants', async (t) => {
  const h = successorFixture(t);
  const result = await h.router.resolveTargetsAndIntent('@opus work', h.threadId, { persist: true });
  assert.deepEqual(result.targetCats, []);
  assert.equal(result.hasMentions, true);
  assert.equal(result.routing_warnings[0]?.kind, 'cat_disabled');
  assert.equal(result.routing_warnings[0]?.alternatives[0]?.mention, '@opus-5');
  assert.deepEqual(h.threads.get(h.threadId).participants, []);
  assert.deepEqual(await h.router.resolveSendTargets([], h.threadId, '@opus work'), []);
  assert.deepEqual(await h.router.resolveExplicitTargets(['opus'], h.threadId), []);
  assert.equal(resolveCatTarget('@opus').error.alternatives[0].catId, 'opus-5');
});

it('a mixed explicit mention only selects the available recipient and retains the disabled warning', async (t) => {
  const h = successorFixture(t);
  const result = await h.router.resolveTargetsAndIntent('@opus @codex work', h.threadId, { allowFallback: false });
  assert.deepEqual(result.targetCats, ['codex']);
  assert.equal(result.routing_warnings[0]?.kind, 'cat_disabled');
  await assert.rejects(h.router.resolveSendTargets(['opus'], h.threadId), /explicit member/);
});

it('successor suggestion respects the runtime catalog mention pattern and routes when followed', async (t) => {
  const h = successorFixture(t);
  process.env.DEFAULT_CAT_ID = 'codex';
  const configs = catRegistry.getAllConfigs();
  catRegistry.reset();
  Object.entries(configs).forEach(([id, config]) =>
    catRegistry.register(id, id === 'opus-5' ? { ...config, mentionPatterns: ['@replacement'] } : config),
  );
  const suggestion = resolveCatTarget('@opus').error.alternatives[0];
  assert.equal(suggestion.catId, 'opus-5');
  assert.deepEqual(await h.router.resolveSendTargets([], h.threadId, `${suggestion.mention} work`), ['opus-5']);
});

it('implicit configured default and runtime override follow the one explicit successor', async (t) => {
  const h = successorFixture(t);
  assert.equal(getDefaultCatId(), 'opus-5');
  setRuntimeDefaultCatId('opus');
  assert.equal(getDefaultCatId(), 'opus-5');
  assert.equal(hasRuntimeDefaultCatOverride(), true);
  assert.deepEqual(await h.router.resolveSendTargets([], h.threadId, 'work'), ['opus-5']);
});

for (const [name, overrides] of [
  ['missing', { opus: { successor: undefined } }],
  ['unknown', { opus: { successor: 'ghost' } }],
  ['self', { opus: { successor: 'opus' } }],
  ['disabled/two-hop', { 'opus-5': { available: false, successor: 'codex' } }],
  ['sentinel', { opus: { successor: '__none__' } }],
]) {
  it(`invalid ${name} successor produces no default or unrelated fallback`, async (t) => {
    const h = successorFixture(t, overrides);
    assert.equal(getDefaultCatId(), '__none__');
    assert.deepEqual(await h.router.resolveSendTargets([], h.threadId, 'work'), []);
    assert.deepEqual((await h.router.previewTargets('work', { threadId: h.threadId })).targetCats, []);
  });
}

it('unregistered successor cannot be used even when roster says available', async (t) => {
  const h = successorFixture(t);
  const configs = catRegistry.getAllConfigs();
  catRegistry.reset();
  Object.entries(configs)
    .filter(([id]) => id !== 'opus-5')
    .forEach(([id, config]) => catRegistry.register(id, config));
  assert.deepEqual(await h.router.resolveSendTargets([], h.threadId, 'work'), []);
});

it('the reserved sentinel cannot become a member through a registered alias', async (t) => {
  const h = successorFixture(t);
  catRegistry.register('__none__', {
    ...catRegistry.getOrThrow('opus-5').config,
    id: '__none__',
    mentionPatterns: ['@not-a-member'],
  });
  assert.ok('error' in resolveCatTarget('@not-a-member'));
  const result = await h.router.resolveTargetsAndIntent('@not-a-member work', h.threadId, { persist: true });
  assert.equal(result.hasMentions, true);
  assert.equal(result.routing_warnings[0]?.kind, 'cat_not_found');
  assert.deepEqual(result.targetCats, []);
  assert.deepEqual(h.threads.get(h.threadId).participants, []);
});

it('schema rejects ambiguous successor configuration', (t) => {
  const h = successorFixture(t);
  h.template.roster.opus.successor = ['opus-5', 'codex'];
  writeFileSync(h.templatePath, JSON.stringify(h.template));
  _resetCachedConfig();
  assert.throws(() => loadCatConfig(h.templatePath));
});

it('historical preferred target resolves without rewriting the user configuration', async (t) => {
  const h = successorFixture(t);
  h.threads.updatePreferredCats(h.threadId, ['opus']);
  assert.deepEqual(await h.router.resolveSendTargets([], h.threadId, 'work'), ['opus-5']);
  assert.deepEqual(h.threads.get(h.threadId).preferredCats, ['opus']);
  assert.equal(JSON.parse(readFileSync(h.templatePath, 'utf8')).roster.opus.available, false);
});

it('previous user mentions and healthy repliers project successor without rewriting history', async (t) => {
  const h = successorFixture(t);
  process.env.DEFAULT_CAT_ID = 'codex';
  const message = await h.messages.append({
    from: { kind: 'user', userId: 'owner' },
    userId: 'owner',
    threadId: h.threadId,
    content: '@opus old',
    mentions: ['opus'],
    timestamp: 1,
  });
  assert.deepEqual(await h.router.resolveSendTargets([], h.threadId, 'work'), ['opus-5']);
  assert.deepEqual((await h.messages.getById(message.id)).mentions, ['opus']);
  const other = h.threads.create('owner');
  h.threads.addParticipants(other.id, ['opus']);
  h.threads.updateParticipantActivity(other.id, 'opus');
  assert.deepEqual(await h.router.resolveSendTargets([], other.id, 'work'), ['opus-5']);
});

it('operational lead remains explicitly declared rather than inherited from predecessor', (t) => {
  successorFixture(t);
  const resolveActor = createActorResolver(getRoster);
  assert.equal(resolveActor('repo-watcher', 'deep'), 'codex');
  getRoster()['opus-5'] = { ...getRoster()['opus-5'], lead: true };
  getRoster().codex = { ...getRoster().codex, lead: false };
  assert.equal(resolveActor('repo-watcher', 'deep'), 'opus-5');
});

it('available members keep their identity regardless of successor metadata', async (t) => {
  const h = successorFixture(t, { opus: { available: true } });
  assert.equal(getDefaultCatId(), 'opus');
  assert.deepEqual(await h.router.resolveSendTargets([], h.threadId, '@opus work'), ['opus']);
  assert.deepEqual(await h.router.resolveSendTargets([], h.threadId, '@opus5 work'), ['opus-5']);
});

it('persisted policy projects successor and its avoid identity without rewriting policy', async (t) => {
  const h = successorFixture(t);
  process.env.DEFAULT_CAT_ID = 'codex';
  const policy = { v: 1, scopes: { review: { preferCats: ['opus'] } } };
  h.threads.updateRoutingPolicy(h.threadId, policy);
  assert.deepEqual(await h.router.resolveSendTargets([], h.threadId, 'review this'), ['opus-5', 'codex']);
  assert.deepEqual(h.threads.get(h.threadId).routingPolicy, policy);
  h.threads.updateRoutingPolicy(h.threadId, {
    v: 1,
    scopes: { review: { preferCats: ['opus'], avoidCats: ['opus-5', 'codex'] } },
  });
  assert.deepEqual(await h.router.resolveSendTargets([], h.threadId, 'review this'), []);
});

it('runtime catalog remains authoritative for successor, lead and private launch metadata', (t) => {
  const h = successorFixture(t);
  const runtime = structuredClone(h.template);
  runtime.roster.opus.successor = 'codex';
  runtime.roster.codex.lead = false;
  runtime.breeds[0].variants[0].cliConfigArgs = ['fixture-private=true'];
  mkdirSync(join(h.root, '.cat-cafe'));
  const path = join(h.root, '.cat-cafe/cat-catalog.json');
  const bytes = JSON.stringify(runtime);
  writeFileSync(path, bytes);
  _resetCachedConfig();
  const loaded = loadCatConfig();
  assert.equal(loaded.roster.opus.successor, 'codex');
  assert.equal(loaded.roster.codex.lead, false);
  assert.deepEqual(loaded.breeds[0].variants[0].cliConfigArgs, ['fixture-private=true']);
  assert.equal(readFileSync(path, 'utf8'), bytes);
});

it('ordinary pre-resolved hint uses its successor before the existing conversation history', async (t) => {
  const h = successorFixture(t);
  h.threads.updateParticipantActivity(h.threadId, 'codex', true);
  assert.deepEqual(await h.router.resolveConversationTargetsAtAdmission(['opus'], h.threadId), ['opus-5']);
  getRoster().opus = { ...getRoster().opus, successor: undefined };
  assert.deepEqual(await h.router.resolveConversationTargetsAtAdmission(['opus'], h.threadId), ['codex']);
  assert.deepEqual(await h.router.resolveConversationTargetsAtAdmission(['ghost'], h.threadId), ['codex']);
  assert.deepEqual(await h.router.resolveConversationTargetsAtAdmission([], h.threadId, '@opus work'), []);
});

it('ordinary hint remains no-target when neither its relation nor conversation policy yields a valid member', async (t) => {
  const h = successorFixture(t, { opus: { successor: 'ghost' } });
  assert.deepEqual(await h.router.resolveConversationTargetsAtAdmission(['opus'], h.threadId), []);
  assert.deepEqual(await h.router.resolveConversationTargetsAtAdmission(['ghost'], h.threadId), []);
});
