import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { afterEach, test } from 'node:test';
import { RECALL_RESOLVER_FAMILIES } from '@cat-cafe/shared';
import { prepareProviderPresentationAttempt } from '../src/domains/cats/services/agents/invocation/provider-presentation-delivery.js';
import { FileProfileRepository } from '../src/domains/cats/services/profile/ProfileRepository.js';
import {
  InMemoryPresentationLedgerStore,
  PresentationLedger,
} from '../src/domains/cats/services/session/context/PresentationLedger.js';
import { MemoryCueInvocationPromptService } from '../src/domains/memory/cue/MemoryCueInvocationPromptService.js';
import { MemoryCuePlaneService } from '../src/domains/memory/cue/MemoryCuePlaneService.js';
import { MemoryCueResolverRegistry } from '../src/domains/memory/cue/MemoryCueResolverRegistry.js';
import { ProfileCueResolver } from '../src/domains/memory/cue/resolvers/ProfileCueResolver.js';
import { PrimerMemoryCueSource } from '../src/domains/memory/cue/sources/PrimerMemoryCueSource.js';

let dataDir: string | undefined;
afterEach(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const approved = `---
opening:
  asOf: "2026-10-03"
  excerpts:
    - kind: relationship
      text: "第一次合奏时，我们把曲子弹完了。"
      source: {threadId: thread-colour, messageId: message-colour}
    - kind: model_capability
      model: gemini-2.5-pro
      text: "这版先只做审读。"
      source: {threadId: thread-model, messageId: message-model}
---
# 关系底稿
完整的其余画像仍按需读取，不自动全量进入开场。
`;

test('only an explicitly selected, sourced opening reference follows the configured individual', async () => {
  dataDir = mkdtempSync(`${tmpdir()}/f332-relationship-`);
  const repository = new FileProfileRepository({
    dataDir,
    relationshipKeyForCat: (id) => (id === 'new-astra-model' ? 'astra' : 'other'),
  });
  const scope = repository.scope('owner', 'new-astra-model');
  const path = repository.primerPath(scope);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, approved);
  const source = new PrimerMemoryCueSource(repository);
  const opening = source.resolvePrimer('owner', 'new-astra-model', { opening: true });
  assert.ok(opening);
  assert.match(opening.summary, /第一次合奏/);
  assert.match(opening.summary, /参考 · 截至 2026-10-03/);
  assert.match(opening.summary, /gemini-2.5-pro/);
  assert.match(opening.summary, /thread-colour#message-colour/);
  assert.doesNotMatch(opening.summary, /完整的其余画像/);
  assert.equal(source.resolvePrimer('owner', 'other-cat', { opening: true }), null);
  const ordinary = source.resolvePrimer('owner', 'new-astra-model');
  assert.ok(ordinary);
  assert.doesNotMatch(ordinary.summary, /第一次合奏/);

  writeFileSync(path, approved.replace('第一次合奏时，我们把曲子弹完了。', '当前更正：按新的称呼相处。'));
  const next = source.resolvePrimer('owner', 'new-astra-model', { opening: true });
  assert.match(next!.summary, /当前更正/);
  assert.notEqual(next!.revision, opening.revision);
  const stale = await source.read({
    ownerUserId: 'owner',
    consumerCatId: 'new-astra-model',
    anchor: opening.anchor,
    expectedRevision: opening.revision,
  });
  assert.deepEqual(stale, { status: 'not_available', invalidationReason: 'source_corrected' });
});

test('an unsourced selection or capability without its model never becomes opening body', () => {
  dataDir = mkdtempSync(`${tmpdir()}/f332-relationship-`);
  const repository = new FileProfileRepository({ dataDir, relationshipKeyForCat: () => 'astra' });
  const path = repository.primerPath(repository.scope('owner', 'astra'));
  mkdirSync(dirname(path), { recursive: true });
  const source = new PrimerMemoryCueSource(repository);
  for (const invalid of [
    approved.replace('source: {threadId: thread-colour, messageId: message-colour}', ''),
    approved.replace('model: gemini-2.5-pro', ''),
  ]) {
    writeFileSync(path, invalid);
    assert.doesNotMatch(source.resolvePrimer('owner', 'astra', { opening: true })!.summary, /第一次合奏|这版先/);
  }
});

test('the production source-to-provider chain carries the selected reference and rejects correction after assembly', async () => {
  dataDir = mkdtempSync(`${tmpdir()}/f332-relationship-`);
  const repository = new FileProfileRepository({ dataDir, relationshipKeyForCat: () => 'astra' });
  const path = repository.primerPath(repository.scope('owner', 'astra'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, approved);
  const source = new PrimerMemoryCueSource(repository);
  const registry = new MemoryCueResolverRegistry(
    RECALL_RESOLVER_FAMILIES.map((family) =>
      family === 'profile'
        ? new ProfileCueResolver(undefined, source)
        : { family, resolverVersion: 1, resolve: async () => [] },
    ),
  );
  const service = new MemoryCueInvocationPromptService({
    plane: new MemoryCuePlaneService(registry),
    createDrillHandle: () => 'test-bound-handle',
    validateContextSource: async () => true,
    sourceReader: {
      read: (input) =>
        source.read({
          ownerUserId: input.scope.ownerUserId,
          consumerCatId: input.consumerCatId,
          anchor: input.anchor,
          expectedRevision: input.expectedRevision,
        }),
    },
  });
  const scope = { ownerUserId: 'owner', threadId: 'thread', invocationId: 'invocation' };
  const now = Date.now();
  const resolved = await service.resolve({
    serverScope: scope,
    now,
    consumerCatId: 'astra',
    seeds: [
      {
        kind: 'fresh_context_sources',
        producer: 'context_epoch',
        occurredAt: now,
        payload: {
          sourceMessageId: 'source',
          contextEpoch: 1,
          evidence: { transition: 'fresh', reason: 'no_prior_session', evidenceRef: 'native' },
        },
      },
    ],
  });
  const attempt = await prepareProviderPresentationAttempt({
    envelopes: resolved.presentationEnvelopes,
    ledger: new PresentationLedger(new InMemoryPresentationLedgerStore()),
    scope: { scopeKey: 'owner::astra::thread', contextEpoch: 1 },
    opportunityContext: { ...scope, consumerCatId: 'astra', surface: 'dynamic_context', now },
    buildEffectivePrompt: (segments) => segments.join('\n'),
  });
  assert.match(attempt.effectivePrompt, /第一次合奏/);
  assert.doesNotMatch(attempt.effectivePrompt, /完整的其余画像/);
  assert.equal(resolved.deliveryReceipts.length, 1);
  writeFileSync(path, '# 当前画像\n已撤下开场片段。');
  assert.equal(await attempt.revalidate(), false, 'a correction must invalidate the already assembled body');
  await attempt.release('source_corrected');
});
