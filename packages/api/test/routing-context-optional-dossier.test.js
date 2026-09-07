import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { _resetDossierCache } from '@cat-cafe/shared/dossier';
import { DossierCapabilityProfileRevisionSource } from '../dist/domains/routing-context/DossierCapabilityProfileRevisionSource.js';
import { RoutingPreferenceKeys } from '../dist/domains/routing-context/RedisRoutingPreferenceStore.js';
import { RoutingSignalEventKeys } from '../dist/domains/routing-context/RedisRoutingSignalEventStore.js';
import { createRoutingContextRuntime } from '../dist/domains/routing-context/RoutingContextRuntime.js';

const roots = [];
const ownerId = 'community-owner';
const config = { clientId: 'openai', defaultModel: 'fixture-model' };
const catIds = ['community-a', 'community-b'];
for (const catId of catIds) catRegistry.register(catId, config);
const input = { ownerId, targetCatIds: catIds };
const profile = (id) => `\`\`\`yaml\n# structured-profile: cat:${id}\nentityId: "cat:${id}"\n\`\`\`\n`;

afterEach(() => {
  _resetDossierCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(content, { states = ['no_evidence', 'no_evidence'], preferences = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'routing-optional-dossier-'));
  roots.push(root);
  const path = join(root, 'docs/team/cat-dossier.md');
  mkdirSync(join(root, 'docs/team'), { recursive: true });
  if (content === null) mkdirSync(path);
  else if (content !== undefined) writeFileSync(path, content);
  const events = states.flatMap((state, index) =>
    state === 'no_evidence'
      ? []
      : [
          {
            v: 1,
            eventId: `signal:${index}`,
            commandId: `signal-command:${index}`,
            ownerId,
            subjectRef: { type: 'cat', catId: catIds[index] },
            source: 'health_probe',
            reasonCode: 'fixture_health',
            evidenceRef: `fixture:${index}`,
            observedAt: Date.now() - 1_000,
            eventType: 'asserted',
            state: state === 'available' || state === 'unknown' ? 'degraded' : state,
            validUntil: Date.now() + (state === 'unknown' ? -100 : 60_000),
          },
        ],
  );
  for (const [index, state] of states.entries()) {
    if (state !== 'available') continue;
    events.push({
      v: 1,
      eventId: `recovery:${index}`,
      commandId: `recovery-command:${index}`,
      ownerId,
      subjectRef: { type: 'cat', catId: catIds[index] },
      source: 'health_probe',
      reasonCode: 'probe_succeeded',
      evidenceRef: `fixture:recovery:${index}`,
      observedAt: Date.now() - 500,
      eventType: 'recovered',
      state: 'available',
      closesSignalIds: [`signal:${index}`],
    });
  }
  const details = new Map([
    ...events.map((event) => [RoutingSignalEventKeys.detail(ownerId, event.eventId), JSON.stringify(event)]),
    ...preferences.map((revision) => [
      RoutingPreferenceKeys.detail(ownerId, revision.revisionId),
      JSON.stringify(revision),
    ]),
  ]);
  // Real production stores hydrate persisted wire values; no Redis connection or store replacement.
  const redis = {
    get: async (key) => details.get(key) ?? null,
    zrange: async (key) => {
      if (key === RoutingSignalEventKeys.ownerTimeline(ownerId)) return events.map((event) => event.eventId);
      if (key === RoutingPreferenceKeys.ownerTimeline(ownerId))
        return preferences.map((revision) => revision.revisionId);
      throw new Error(`unexpected timeline ${key}`);
    },
    mget: async (...keys) => keys.map((key) => details.get(key) ?? null),
  };
  const runtime = createRoutingContextRuntime({
    redis,
    projectRoot: root,
    getConfigs: () => Object.fromEntries(catIds.map((id) => [id, config])),
  });
  return { root, path, runtime };
}

test('public install without dossier keeps owner reads fresh and ordinary dispatch allowed', async () => {
  const { runtime } = fixture();
  const read = await runtime.readService.read({ ...input, observedAt: Date.now() });
  assert.equal(read.resolution.state, 'fresh');
  assert.ok(read.resolution.snapshot.candidates.every((candidate) => candidate.profile.state === 'absent'));
  const decision = await runtime.dispatchPreflight.preflight(input);
  assert.equal(decision.resolverState, 'fresh');
  assert.ok(decision.targets.every((target) => target.disposition === 'allowed'));
  assert.ok(
    decision.targets.every((target) => target.reasons.every((reason) => reason.code !== 'routing_context_unavailable')),
  );
});

for (const [state, disposition] of [
  ['unavailable', 'rejected'],
  ['available', 'allowed'],
  ['scarce', 'warned'],
  ['degraded', 'warned'],
  ['unknown', 'warned'],
]) {
  test(`missing dossier preserves real ${state} availability as ${disposition}`, async () => {
    const { runtime } = fixture(undefined, { states: [state, 'available'] });
    const decision = await runtime.dispatchPreflight.preflight(input);
    assert.equal(decision.resolverState, 'fresh');
    assert.equal(decision.targets[0].disposition, disposition);
    assert.ok(decision.targets[0].reasons.every((reason) => reason.code !== 'routing_context_unavailable'));
    assert.deepEqual(decision.targets[0].alternatives, [], 'unprofiled cats are never invented as alternatives');
  });
}

for (const [label, content] of [
  ['read failure', null],
  [
    'invalid yaml without usable identity',
    profile(catIds[0]).replace('entityId: "cat:community-a"', 'entityId: [broken'),
  ],
  ['unclosed block', profile(catIds[0]).slice(0, -4)],
  ['identity mismatch', profile(catIds[0]).replace('entityId: "cat:community-a"', 'entityId: "cat:someone-else"')],
]) {
  test(`existing ${label} dossier remains degraded in required and optional modes`, async () => {
    const { root, runtime } = fixture(content);
    const catalog = await runtime.catalogSource.load({ ownerId });
    for (const dossierMode of ['required', 'optional']) {
      const source = new DossierCapabilityProfileRevisionSource({ projectRoot: root, dossierMode });
      assert.equal(
        (await source.load({ ownerId, candidates: catalog.candidates })).reason,
        'dossier_unreadable_or_empty',
      );
    }
    const read = await runtime.readService.read({ ...input, observedAt: Date.now() });
    assert.equal(read.resolution.state, 'degraded');
    const decision = await runtime.dispatchPreflight.preflight(input);
    assert.equal(decision.targets[0].reasons[0].code, 'routing_context_unavailable');
  });
}

test('same production graph sees absent → partial → corrupt → repaired → absent without restart', async () => {
  const { runtime, path } = fixture();
  const read = () => runtime.readService.read({ ...input, observedAt: Date.now() });
  assert.equal((await read()).resolution.state, 'fresh');
  writeFileSync(path, profile(catIds[0]));
  const partial = (await read()).resolution;
  assert.equal(partial.state, 'fresh');
  assert.deepEqual(
    partial.snapshot.candidates.map((entry) => entry.profile.state),
    ['applied', 'absent'],
  );
  writeFileSync(path, profile(catIds[0]).replace('entityId: "cat:community-a"', 'entityId: [broken'));
  assert.equal((await read()).resolution.state, 'degraded');
  writeFileSync(path, catIds.map(profile).join('\n'));
  assert.ok((await read()).resolution.snapshot.candidates.every((entry) => entry.profile.state === 'applied'));
  rmSync(path);
  assert.ok((await read()).resolution.snapshot.candidates.every((entry) => entry.profile.state === 'absent'));
});

for (const content of ['', '# My team\nA prose-only dossier.']) {
  test('optional placeholder/prose is absent while required still diagnoses no profiles', async () => {
    const { runtime, root } = fixture(content, { states: ['unavailable', 'available'] });
    const catalog = await runtime.catalogSource.load({ ownerId });
    const required = new DossierCapabilityProfileRevisionSource({ projectRoot: root });
    assert.equal(
      (await required.load({ ownerId, candidates: catalog.candidates })).reason,
      'dossier_unreadable_or_empty',
    );
    const read = await runtime.readService.read({ ...input, observedAt: Date.now() });
    assert.equal(read.resolution.state, 'fresh');
    assert.ok(read.resolution.snapshot.candidates.every((entry) => entry.profile.state === 'absent'));
    assert.equal((await runtime.dispatchPreflight.preflight(input)).targets[0].disposition, 'rejected');
  });
}

for (const [label, broken, expectedState] of [
  ['missing identity', profile(catIds[1]).replace('entityId: "cat:community-b"\n', ''), 'absent'],
  ['invalid yaml', profile(catIds[1]).replace('entityId:', 'broken: [\nentityId:'), 'applied'],
  ['unclosed block', profile(catIds[1]).slice(0, -4), 'absent'],
  ['Chinese colon', profile(catIds[1]).replace('entityId:', 'oneLiner: 深度推理: 系统设计\nentityId:'), 'applied'],
  ['tab indentation', profile(catIds[1]).replace('entityId:', '\tentityId:'), 'applied'],
  ['bare handle', profile(catIds[1]).replace('entityId:', 'handle: @x\nentityId:'), 'applied'],
  ['duplicate profile', profile(catIds[1]) + profile(catIds[1]), 'applied'],
]) {
  test(`mixed ${label} remains local and does not weaken unavailable rejection`, async () => {
    const { runtime } = fixture(profile(catIds[0]) + broken, { states: ['unavailable', 'available'] });
    const read = await runtime.readService.read({ ...input, observedAt: Date.now() });
    assert.equal(read.resolution.state, 'fresh');
    const byId = new Map(read.resolution.snapshot.candidates.map((entry) => [entry.binding.catId, entry]));
    assert.equal(byId.get(catIds[0]).profile.state, 'applied');
    assert.equal(byId.get(catIds[1]).profile.state, expectedState);
    const decision = await runtime.dispatchPreflight.preflight(input);
    assert.equal(decision.targets[0].disposition, 'rejected');
    assert.equal(decision.targets[1].disposition, 'warned');
    assert.ok(decision.targets[1].reasons.some((reason) => reason.code === 'capability_profile_invalid'));
  });
}

for (const extra of ['oneLiner: 深度推理: 系统设计', '\tannotation: value', 'handle: @x']) {
  test(`single usable block remains applied despite syntax diagnostics: ${extra}`, async () => {
    const { runtime } = fixture(profile(catIds[0]).replace('entityId:', `${extra}\nentityId:`), {
      states: ['unavailable', 'available'],
    });
    const read = await runtime.readService.read({ ...input, targetCatIds: [catIds[0]], observedAt: Date.now() });
    assert.equal(read.resolution.state, 'fresh');
    assert.equal(read.resolution.snapshot.candidates[0].profile.state, 'applied');
    assert.equal((await runtime.dispatchPreflight.preflight(input)).targets[0].disposition, 'rejected');
  });
}

test('required remains the adapter default, and optional does not hide missing model contracts', async () => {
  const { root, path, runtime } = fixture();
  const catalog = await runtime.catalogSource.load({ ownerId });
  const required = new DossierCapabilityProfileRevisionSource({ projectRoot: root });
  assert.equal((await required.load({ ownerId, candidates: catalog.candidates })).reason, 'dossier_unavailable');
  writeFileSync(path, profile(catIds[0]));
  const optional = new DossierCapabilityProfileRevisionSource({
    projectRoot: root,
    dossierMode: 'optional',
    modelResolver: () => undefined,
  });
  assert.deepEqual(await optional.load({ ownerId, candidates: catalog.candidates }), {
    status: 'degraded',
    reason: 'model_missing',
    affectedCatIds: [catIds[0]],
  });
});

test('missing optional dossier preserves scoped preferences and review-due lifecycle', async () => {
  const now = Date.now();
  const preference = {
    v: 1,
    preferenceId: 'prefer-b',
    revisionId: 'prefer-b:1',
    commandId: 'preference-command',
    ownerId,
    appliesWhen: { intent: 'review', requireEligible: catIds.map((catId) => ({ type: 'cat', catId })) },
    prefer: [{ type: 'cat', catId: catIds[1] }],
    over: [{ type: 'cat', catId: catIds[0] }],
    rationale: 'Prefer B when both are eligible',
    evidenceRefs: ['fixture:preference'],
    version: 1,
    validFrom: now - 1_000,
    lifecycle: 'active',
    reviewAfter: now + 10_000,
  };
  const { runtime } = fixture(undefined, { preferences: [preference] });
  const scoped = await runtime.readService.read({ ...input, observedAt: now, intent: 'review' });
  assert.equal(scoped.resolution.state, 'fresh');
  assert.ok(scoped.resolution.snapshot.candidates.some((entry) => entry.matchedPreferences.length > 0));
  const architecture = await runtime.readService.read({ ...input, observedAt: now, intent: 'architecture' });
  assert.ok(architecture.resolution.snapshot.candidates.every((entry) => entry.matchedPreferences.length === 0));
  const due = await runtime.readService.read({ ...input, observedAt: now + 20_000, intent: 'review' });
  assert.ok(
    due.resolution.snapshot.candidates.every((entry) => entry.matchedPreferences[0]?.lifecycle === 'review_due'),
  );
});
