import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createMicroduckExplorationBindings } from '../dist/infrastructure/capability-evolution/adapters/microduck-exploration/publication.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
const programRef = { ownerFeatureId: 'F311', ownerStateRef: 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68' };
const objectRef = { ownerFeatureId: 'microduck-owner', ownerStateRef: 'simulator:walking', version: '1' };
const input = { programRef, objectRef };
const unavailable = () => ({
  schemaVersion: 1,
  status: 'unavailable',
  ...input,
  blockers: [{ code: 'target_drift', ownerRef: objectRef }],
});
const owner = (options = {}) =>
  createMicroduckExplorationBindings({ repoRoot, versionReview: async () => unavailable(), ...options });

test('comparison inventory order never invents a public lineage edge without a declared parent', async () => {
  const binding = owner({
    readBytes: async (file) => {
      const bytes = await readFile(file);
      if (!file.endsWith('/20260909-short-approach/comparison.json')) return bytes;
      const value = JSON.parse(bytes.toString('utf8'));
      value.runs.reverse();
      return Buffer.from(JSON.stringify(value));
    },
  });
  const review = await binding.explorationReview(input);
  assert.equal(review.status, 'resolved');
  for (const title of ['v5', 'v6', 'v7', 'v8']) {
    const node = review.nodes.find((entry) => entry.title === title);
    assert.deepEqual(node.parentEdges, [], `${title} has no declared parent in this inventory`);
  }
  const v4 = review.nodes.find((entry) => entry.title === 'v4');
  assert.equal(v4.parentEdges.length, 1, 'declared catalog ancestry remains available');
});

test('owner failure, unavailable and invalid identities stay visible alongside readable public archives', async () => {
  const cases = [
    [async () => unavailable(), 'target_drift'],
    [
      async () => {
        throw new Error('owner offline');
      },
      'owner_version_review_failed',
    ],
    [async () => undefined, 'owner_version_review_invalid'],
    [
      async () => ({ ...unavailable(), objectRef: { ...objectRef, ownerStateRef: 'simulator:another-object' } }),
      'owner_version_review_identity_mismatch',
    ],
  ];
  for (const [versionReview, code] of cases) {
    const review = await owner({ versionReview }).explorationReview(input);
    assert.equal(review.status, 'resolved', 'public sources have an independent read boundary');
    assert.equal(review.nodes.filter((node) => node.kind === 'public_archive').length, 9);
    assert(
      review.blockers.some((entry) => entry.code === code),
      `missing ${code}`,
    );
    assert.equal(review.nodes.filter((node) => node.kind === 'owner_version').length, 0);
  }
});

test('unreadable or corrupt replay provenance is a media failure, not an absent media inventory', async () => {
  for (const mode of ['offline', 'hash', 'manifest']) {
    const binding = owner({
      readBytes: async (file) => {
        if (mode === 'manifest' && file.endsWith('/20260909-demo/catalog.json')) {
          const catalog = JSON.parse((await readFile(file)).toString('utf8'));
          const row = catalog.episodes.find(
            (entry) => entry.runId === '20260907-approach-v2' && entry.caseId === 'approach-left-straight',
          );
          row.identicalCaptureReplayVideoRef.sha256 = '0'.repeat(64);
          return Buffer.from(JSON.stringify(catalog));
        }
        if (mode !== 'manifest' && file.endsWith('/20260907-approach-v2/media-run.json')) {
          if (mode === 'hash') return Buffer.from('corrupt replay');
          throw new Error('source offline');
        }
        return readFile(file);
      },
    });
    const catalog = await binding.explorationReview(input);
    const run = catalog.experiments.find((entry) => entry.title.includes('20260907-approach-v2'));
    const review = await binding.explorationReview({
      ...input,
      selectedNodeRef: run.nodeRef,
      selectedExperimentRef: run.experimentRef,
    });
    const detail = review.details[0];
    assert.equal(detail.status, 'resolved', 'numerical records remain readable');
    const record = detail.records.find((entry) => entry.caseId === 'approach-left-straight');
    assert.equal(record.mediaStatus?.status, mode === 'offline' ? 'unavailable' : 'invalid');
    assert.equal(record.media.length, 0);
    assert(record.trace.points.length > 0);
  }
});
