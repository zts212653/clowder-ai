import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createLocalArtifactPublisher } from '../../dist/infrastructure/harness-eval/publish-verdict/local-artifact-publisher.js';
import {
  expectedArtifactDir,
  makePacket,
  OWNER,
  publishOpts,
  writingGenerator,
} from './local-artifact-publisher-fixtures.js';

describe('createLocalArtifactPublisher', () => {
  let artifactRoot;

  afterEach(() => {
    if (artifactRoot) {
      rmSync(artifactRoot, { recursive: true, force: true });
      artifactRoot = undefined;
    }
  });

  it('atomically commits verdict.md and bundle/ inside the owner partition', async () => {
    artifactRoot = mkdtempSync(join(tmpdir(), 'artifact-store-'));
    const publisher = createLocalArtifactPublisher({ artifactRoot });
    const packet = makePacket();

    const ref = await publisher.publishArtifact(publishOpts(packet, writingGenerator(packet)));

    const artifactDir = expectedArtifactDir(artifactRoot, OWNER, 'eval-harness-ledger', packet.id);
    assert.equal(ref.verdictPath, join(artifactDir, 'docs', 'harness-feedback', 'verdicts', `${packet.id}.md`));
    assert.equal(ref.bundleDir, join(artifactDir, 'docs', 'harness-feedback', 'bundles', packet.id));
    assert.equal(existsSync(join(ref.bundleDir, 'snapshot.json')), true);
    assert.equal(readFileSync(ref.verdictPath, 'utf8'), '# Verdict\n');
    assert.equal(ref.domainSlug, 'eval-harness-ledger');
    assert.equal(ref.artifactId, packet.id);
    assert.match(ref.artifactUrl, /^artifact:\/\/eval-harness-ledger\/hlr-20260729-abcdef12$/);
  });

  it('rejects duplicate artifactId for the same owner with artifact_already_exists', async () => {
    artifactRoot = mkdtempSync(join(tmpdir(), 'artifact-store-'));
    const publisher = createLocalArtifactPublisher({ artifactRoot });
    const packet = makePacket();
    const run = () => publisher.publishArtifact(publishOpts(packet, writingGenerator(packet)));

    await run();
    await assert.rejects(run(), /artifact_already_exists/);
  });

  it('rejects a publication without an owner before staging or generating', async () => {
    artifactRoot = mkdtempSync(join(tmpdir(), 'artifact-store-'));
    const publisher = createLocalArtifactPublisher({ artifactRoot });
    const packet = makePacket();
    let generateCalls = 0;

    const generate = async () => {
      generateCalls += 1;
      throw new Error('generator must not run');
    };
    for (const ownerUserId of [undefined, '', '   ']) {
      await assert.rejects(
        publisher.publishArtifact({ ...publishOpts(packet, generate), ownerUserId }),
        /owner_user_required/,
      );
    }
    assert.equal(generateCalls, 0);
    assert.deepEqual(readdirSync(artifactRoot), [], 'nothing may be created without an owner');
  });

  it('rejects unsafe artifact ids before constructing filesystem paths', async () => {
    artifactRoot = mkdtempSync(join(tmpdir(), 'artifact-store-'));
    const publisher = createLocalArtifactPublisher({ artifactRoot });
    let generateCalls = 0;

    await assert.rejects(
      publisher.publishArtifact(
        publishOpts(makePacket({ id: '../escape' }), async () => {
          generateCalls += 1;
          throw new Error('generator must not run');
        }),
      ),
      /unsafe_artifact_id/,
    );

    assert.equal(generateCalls, 0, 'unsafe ids must fail before staging or generator execution');
  });

  it('rejects unsafe domain slugs before constructing filesystem paths', async () => {
    artifactRoot = mkdtempSync(join(tmpdir(), 'artifact-store-'));
    const publisher = createLocalArtifactPublisher({ artifactRoot });
    let generateCalls = 0;

    await assert.rejects(
      publisher.publishArtifact(
        publishOpts(makePacket({ domainId: 'eval:../../escape' }), async () => {
          generateCalls += 1;
          throw new Error('generator must not run');
        }),
      ),
      /unsafe_domain_slug/,
    );

    assert.equal(generateCalls, 0, 'unsafe domain slugs must fail before staging or generator execution');
  });

  it('executes afterPublish exactly once after durable commit', async () => {
    artifactRoot = mkdtempSync(join(tmpdir(), 'artifact-store-'));
    const publisher = createLocalArtifactPublisher({ artifactRoot });
    const packet = makePacket();
    let afterPublishCalls = 0;

    await publisher.publishArtifact(
      publishOpts(
        packet,
        writingGenerator(packet, {
          afterPublish() {
            afterPublishCalls += 1;
          },
        }),
      ),
    );

    assert.equal(afterPublishCalls, 1);
  });

  it('cleans up staging directory when generator fails', async () => {
    artifactRoot = mkdtempSync(join(tmpdir(), 'artifact-store-'));
    const publisher = createLocalArtifactPublisher({ artifactRoot });
    const packet = makePacket();

    await assert.rejects(
      publisher.publishArtifact(
        publishOpts(packet, async () => {
          throw new Error('generator failed');
        }),
      ),
      /generator failed/,
    );

    const ownerRoot = dirname(dirname(expectedArtifactDir(artifactRoot, OWNER, 'eval-harness-ledger', packet.id)));
    assert.equal(
      readdirSync(ownerRoot).some((name) => name.startsWith('.staging-')),
      false,
      'staging dir must be removed',
    );
  });

  it('rolls back committed artifact when afterPublish fails', async () => {
    artifactRoot = mkdtempSync(join(tmpdir(), 'artifact-store-'));
    const publisher = createLocalArtifactPublisher({ artifactRoot });
    const packet = makePacket({ id: 'hlr-afterpublish-fail-001' });
    const finalDir = expectedArtifactDir(artifactRoot, OWNER, 'eval-harness-ledger', packet.id);

    await assert.rejects(
      publisher.publishArtifact(
        publishOpts(
          packet,
          writingGenerator(packet, {
            afterPublish() {
              throw new Error('writeback failed');
            },
          }),
        ),
      ),
      /artifact_publish_rollback/,
    );

    assert.equal(existsSync(finalDir), false, 'artifact must be rolled back after afterPublish failure');
  });

  it('preserves typed domain errors from afterPublish while rolling back', async () => {
    artifactRoot = mkdtempSync(join(tmpdir(), 'artifact-store-'));
    const publisher = createLocalArtifactPublisher({ artifactRoot });
    const packet = makePacket({ id: 'hlr-domain-error-001' });
    const finalDir = expectedArtifactDir(artifactRoot, OWNER, 'eval-harness-ledger', packet.id);

    await assert.rejects(
      publisher.publishArtifact(
        publishOpts(
          packet,
          writingGenerator(packet, {
            afterPublish() {
              throw new Error('invalid_episode_verdict_writeback: stale claim');
            },
          }),
        ),
      ),
      /invalid_episode_verdict_writeback: stale claim/,
    );

    assert.equal(existsSync(finalDir), false, 'artifact must be rolled back after afterPublish domain error');
  });

  it('normalizes concurrent duplicate publish race to artifact_already_exists', async () => {
    artifactRoot = mkdtempSync(join(tmpdir(), 'artifact-store-'));
    const publisher = createLocalArtifactPublisher({ artifactRoot });
    const packet = makePacket({ id: 'hlr-concurrent-001' });
    const write = writingGenerator(packet);

    // Yield the event loop so both publishers pass the initial existsSync check
    // before either reaches the atomic rename, forcing the EEXIST/ENOTEMPTY race.
    const opts = publishOpts(packet, async (outputRoot) => {
      await new Promise((r) => setTimeout(r, 10));
      return write(outputRoot);
    });

    const [a, b] = await Promise.allSettled([publisher.publishArtifact(opts), publisher.publishArtifact(opts)]);

    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    const rejected = [a, b].filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'exactly one concurrent publish must succeed');
    assert.equal(rejected.length, 1, 'exactly one concurrent publish must fail');
    assert.match(
      rejected[0].reason instanceof Error ? rejected[0].reason.message : String(rejected[0].reason),
      /artifact_already_exists/,
      'the loser must be normalized to artifact_already_exists',
    );
  });
});
