import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { listOwnerArtifactVerdicts } from '../../dist/infrastructure/harness-eval/artifact-store/artifact-store-reader.js';
import { mapPublishVerdictError } from '../../dist/infrastructure/harness-eval/publish-verdict/error-mapping.js';
import { createLocalArtifactPublisher } from '../../dist/infrastructure/harness-eval/publish-verdict/local-artifact-publisher.js';
import {
  expectedArtifactDir,
  hubReadableGenerator,
  makePacket,
  publishOpts,
} from './local-artifact-publisher-fixtures.js';

/**
 * F257 — a verdict id names one verdict in its owner's store.
 *
 * The Eval Hub, the lifecycle roots and the lifecycle log all address a runtime
 * verdict by its bare id, the way the product repository's single `verdicts/`
 * directory once made ids unique by construction. Artifact containers are separate
 * directories, so nothing stopped two of them from publishing one id — the same
 * packet id in two domains, or a new parent id equal to another publication's child.
 * Both publications succeeded, and the reader kept whichever sorted first.
 */

const LEDGER = 'eval-harness-ledger';

describe('verdict ids in one owner store', () => {
  let tmp;
  let artifactRoot;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'artifact-verdict-ids-'));
    artifactRoot = join(tmp, 'artifacts');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function publish(owner, { id, domainId = 'eval:harness-ledger', children = [], afterPublish, parked }) {
    const packet = makePacket({ id, domainId });
    const write = hubReadableGenerator(packet, { children });
    const generate = async (outputRoot) => {
      const generated = await write(outputRoot);
      if (parked) await parked();
      return afterPublish ? { ...generated, afterPublish } : generated;
    };
    return createLocalArtifactPublisher({ artifactRoot }).publishArtifact(publishOpts(packet, generate, owner));
  }

  const listed = (owner) =>
    listOwnerArtifactVerdicts(artifactRoot, owner).map(
      ({ coordinates }) => `${coordinates.domainSlug}/${coordinates.artifactId}/${coordinates.verdictId}`,
    );

  const assertTaken = (err) => {
    assert.match(err.message, /^verdict_id_taken: /);
    assert.deepEqual(mapPublishVerdictError(err.message)?.status, 409);
    return true;
  };

  it('refuses an artifact whose child id another artifact already published', async () => {
    await publish('owner-a', { id: 'container-a', children: [{ id: 'shared-child' }] });

    await assert.rejects(publish('owner-a', { id: 'container-b', children: [{ id: 'shared-child' }] }), assertTaken);
    assert.equal(existsSync(expectedArtifactDir(artifactRoot, 'owner-a', LEDGER, 'container-b')), false);
    assert.deepEqual(listed('owner-a'), [`${LEDGER}/container-a/container-a`, `${LEDGER}/container-a/shared-child`]);
  });

  it('refuses a packet id that another domain already published', async () => {
    await publish('owner-a', { id: 'same-packet' });

    await assert.rejects(publish('owner-a', { id: 'same-packet', domainId: 'eval:friction' }), assertTaken);
    assert.deepEqual(listed('owner-a'), [`${LEDGER}/same-packet/same-packet`]);
  });

  it('refuses a new verdict whose id is already another artifact’s child', async () => {
    await publish('owner-a', { id: 'container-a', children: [{ id: 'later-parent' }] });

    await assert.rejects(publish('owner-a', { id: 'later-parent' }), assertTaken);
    assert.deepEqual(listed('owner-a'), [`${LEDGER}/container-a/container-a`, `${LEDGER}/container-a/later-parent`]);
  });

  it('lets exactly one of two concurrent publications take a shared id', async () => {
    let arrived = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    // Both generators have fully written their staged trees before either publisher continues.
    const parked = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await gate;
    };

    const results = await Promise.allSettled([
      publish('owner-a', { id: 'container-a', children: [{ id: 'shared-child' }], parked }),
      publish('owner-a', { id: 'container-b', children: [{ id: 'shared-child' }], parked }),
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1, JSON.stringify(results));
    assertTaken(results.find((result) => result.status === 'rejected').reason);
    assert.equal(listed('owner-a').filter((entry) => entry.endsWith('/shared-child')).length, 1);
  });

  it('keeps a failed publication’s ids for a retry of that artifact and from every other artifact', async () => {
    const failing = () => {
      throw new Error('side effect failed');
    };
    await assert.rejects(
      publish('owner-a', { id: 'container-a', children: [{ id: 'shared-child' }], afterPublish: failing }),
      /^Error: artifact_publish_rollback/,
    );
    assert.deepEqual(listed('owner-a'), []);

    await assert.rejects(publish('owner-a', { id: 'container-b', children: [{ id: 'shared-child' }] }), assertTaken);
    await publish('owner-a', { id: 'container-a', children: [{ id: 'shared-child' }] });
    assert.deepEqual(listed('owner-a'), [`${LEDGER}/container-a/container-a`, `${LEDGER}/container-a/shared-child`]);
  });

  it('does not let a single generation claim one id twice', async () => {
    await assert.rejects(
      publish('owner-a', { id: 'container-a', children: [{ id: 'twin' }, { id: 'twin' }] }),
      /^Error: artifact_coordinate_mismatch: .*'twin'.* more than once/,
    );
    await assert.rejects(
      publish('owner-a', { id: 'container-b', children: [{ id: 'container-b' }] }),
      /^Error: artifact_coordinate_mismatch: .*'container-b'.* more than once/,
    );
    assert.deepEqual(listed('owner-a'), []);
  });

  it('keeps two owners’ ids independent', async () => {
    await publish('owner-a', { id: 'container-a', children: [{ id: 'shared-child' }] });
    await publish('owner-b', { id: 'container-b', children: [{ id: 'shared-child' }] });

    assert.deepEqual(listed('owner-a'), [`${LEDGER}/container-a/container-a`, `${LEDGER}/container-a/shared-child`]);
    assert.deepEqual(listed('owner-b'), [`${LEDGER}/container-b/container-b`, `${LEDGER}/container-b/shared-child`]);
  });

  it('refuses to choose between two artifacts that hold the same verdict id', async () => {
    await publish('owner-a', { id: 'container-a', children: [{ id: 'shared-child' }] });
    await publish('owner-a', { id: 'container-b' });
    // An edit outside the publisher copies the child into a second container.
    const from = join(expectedArtifactDir(artifactRoot, 'owner-a', LEDGER, 'container-a'), 'docs', 'harness-feedback');
    const to = join(expectedArtifactDir(artifactRoot, 'owner-a', LEDGER, 'container-b'), 'docs', 'harness-feedback');
    cpSync(join(from, 'verdicts', 'shared-child.md'), join(to, 'verdicts', 'shared-child.md'));
    cpSync(join(from, 'bundles', 'shared-child'), join(to, 'bundles', 'shared-child'), { recursive: true });

    assert.throws(
      () => listOwnerArtifactVerdicts(artifactRoot, 'owner-a'),
      /^Error: verdict_id_conflict: verdict 'shared-child' is held by eval-harness-ledger\/container-a and eval-harness-ledger\/container-b/,
    );
  });
});
