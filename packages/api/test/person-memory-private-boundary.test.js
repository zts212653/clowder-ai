import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const forbiddenProjectionFiles = [
  'src/domains/memory/f263-lifecycle-collector.ts',
  'src/domains/memory/LifecycleTraceStore.ts',
  'src/domains/memory/RecallEventCorrelator.ts',
  'src/domains/memory/recall-correlation-hook.ts',
  'src/domains/memory/EventMemoryStore.ts',
  'src/domains/memory/event-backfill.ts',
];

const forbiddenHydrationFiles = [
  'src/domains/cats/services/session/SessionBootstrap.ts',
  'src/domains/memory/CollectionIndexBuilder.ts',
  'src/domains/memory/GlobalIndexBuilder.ts',
  'src/domains/memory/IndexBuilder.ts',
  'src/domains/memory/SqliteEvidenceStore.ts',
  'src/domains/memory/push-recall.ts',
];

const privateIdentifierPattern =
  /PersonMemory|person-memory|PersonId|personId|candidateId|person_claim_|person_event_|workspaceEntityPerson|workspaceEntityLink|workspace-entity-person/;

async function assertNoPrivatePersonProjection(files) {
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, privateIdentifierPattern, `${file} must not consume F276 private identifiers`);
  }
}

describe('F276 private-cell boundary', () => {
  it('does not project identifiers into F200, F227, or F263 persistence', async () => {
    await assertNoPrivatePersonProjection(forbiddenProjectionFiles);
  });

  it('does not hydrate pending or canonical dossiers into bootstrap or search indexes', async () => {
    await assertNoPrivatePersonProjection(forbiddenHydrationFiles);
  });
});
