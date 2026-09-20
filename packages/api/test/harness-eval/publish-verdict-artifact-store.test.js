import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createLocalArtifactPublisher } from '../../dist/infrastructure/harness-eval/publish-verdict/local-artifact-publisher.js';
import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';
import { buildPacket } from './publish-verdict-fixtures.js';

/**
 * F257 — `handlePublishVerdict` through the real local artifact publisher.
 *
 * Handler suites use a storage-neutral mock publisher, which is how a duplicate
 * artifact came to surface as a 500: the mock and the error mapping agreed with
 * each other, and neither agreed with the publisher that runs in production.
 */
describe('handlePublishVerdict with the local artifact store', () => {
  let root;
  let artifactRoot;
  let generatorCalls;

  beforeEach(() => {
    root = setupHarnessFeedback();
    artifactRoot = mkdtempSync(join(tmpdir(), 'publish-verdict-artifact-store-'));
    generatorCalls = 0;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(artifactRoot, { recursive: true, force: true });
  });

  function generator(overrides = {}) {
    return async (packet, _sourceRefs, deps) => {
      generatorCalls += 1;
      const verdictPath = join(deps.harnessFeedbackRoot, 'verdicts', `${packet.id}.md`);
      const bundleDir = join(deps.harnessFeedbackRoot, 'bundles', packet.id);
      mkdirSync(dirname(verdictPath), { recursive: true });
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(verdictPath, '# Verdict\n');
      return { verdictPath, bundleDir, ...overrides };
    };
  }

  function publish(ownerUserId, gen = generator()) {
    return handlePublishVerdict(
      { harnessFeedbackRoot: root, artifactPublisher: createLocalArtifactPublisher({ artifactRoot }), generator: gen },
      {
        packet: buildPacket({ id: 'artifact-store-shared-id' }),
        domain: 'eval:a2a',
        catId: 'codex',
        ownerUserId,
        sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
      },
    );
  }

  it('maps a duplicate publication for the same owner to 409', async () => {
    const first = await publish('owner-a');
    assert.equal(first.ok, true, JSON.stringify(first));

    const duplicate = await publish('owner-a');
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate));
    assert.equal(duplicate.error, 'verdict_already_exists');
    assert.match(duplicate.detail, /^artifact_already_exists/);
  });

  it('lets another owner publish the same verdict id', async () => {
    assert.equal((await publish('owner-a')).ok, true);
    const other = await publish('owner-b');
    assert.equal(other.ok, true, JSON.stringify(other));
    assert.equal(other.artifactId, 'artifact-store-shared-id');
  });

  it('refuses a publication without an owner before any generation', async () => {
    for (const ownerUserId of [undefined, '', '  ']) {
      const result = await publish(ownerUserId);
      assert.equal(result.status, 401, JSON.stringify(result));
      assert.match(result.detail, /owner_user_required/);
    }
    assert.equal(generatorCalls, 0);
    assert.deepEqual(readdirSync(artifactRoot), []);
  });

  it('treats a generator that names a bundle outside its output root as failed, before writing into it', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'publish-verdict-outside-'));
    try {
      const result = await publish('owner-a', generator({ bundleDir: outside }));
      assert.equal(result.status, 500, JSON.stringify(result));
      assert.equal(result.error, 'generator_failed');
      assert.match(result.detail, /^artifact_coordinate_mismatch/);
      assert.deepEqual(readdirSync(outside), [], 'no lifecycle root may be written outside the artifact');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
