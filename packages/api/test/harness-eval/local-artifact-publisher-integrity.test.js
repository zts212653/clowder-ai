import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createLocalArtifactPublisher } from '../../dist/infrastructure/harness-eval/publish-verdict/local-artifact-publisher.js';
import {
  expectedArtifactDir,
  makePacket,
  OWNER,
  publishOpts,
  writingGenerator,
} from './local-artifact-publisher-fixtures.js';

/**
 * F257 — the publisher confirms only what it actually published.
 *
 * A generator's return value names where it wrote the verdict. Before this suite,
 * the publisher only checked that the named paths existed somewhere: a generator
 * could return files outside the staging tree and the publication succeeded,
 * `afterPublish` ran, and the returned canonical paths did not exist. Every case
 * here must fail closed with no artifact, no staging leftovers and no side effect.
 */
describe('local artifact publisher integrity', () => {
  let tmp;
  let artifactRoot;
  let outside;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'artifact-integrity-'));
    artifactRoot = join(tmp, 'store');
    outside = join(tmp, 'outside');
    mkdirSync(outside, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function assertFailsClosed(packet, generate, pattern) {
    const publisher = createLocalArtifactPublisher({ artifactRoot });
    let afterPublishCalls = 0;
    await assert.rejects(
      publisher.publishArtifact(
        publishOpts(packet, async (outputRoot) => {
          const generated = await generate(outputRoot);
          return {
            ...generated,
            afterPublish() {
              afterPublishCalls += 1;
            },
          };
        }),
      ),
      pattern,
    );
    const finalDir = expectedArtifactDir(artifactRoot, OWNER, 'eval-harness-ledger', packet.id);
    assert.equal(afterPublishCalls, 0, 'afterPublish must not run for an unconfirmed artifact');
    assert.equal(existsSync(finalDir), false, 'no artifact may be exposed');
    const ownerRoot = dirname(dirname(finalDir));
    assert.equal(
      readdirSync(ownerRoot).some((name) => name.startsWith('.staging-')),
      false,
      'staging must be removed',
    );
  }

  it('rejects a generator that reports existing files outside the staging tree (review repro)', async () => {
    const packet = makePacket({ id: 'hlr-outside-report' });
    const externalVerdict = join(outside, 'verdict.md');
    writeFileSync(externalVerdict, '# not published\n');

    await assertFailsClosed(
      packet,
      async () => ({ verdictPath: externalVerdict, bundleDir: outside }),
      /artifact_coordinate_mismatch/,
    );
  });

  it('rejects an outside path even when the canonical files were also written', async () => {
    const packet = makePacket({ id: 'hlr-outside-and-canonical' });
    const write = writingGenerator(packet);

    await assertFailsClosed(
      packet,
      async (outputRoot) => ({ ...(await write(outputRoot)), bundleDir: outside }),
      /artifact_coordinate_mismatch/,
    );
  });

  it('rejects canonical coordinates whose files were never written', async () => {
    const packet = makePacket({ id: 'hlr-never-written' });

    await assertFailsClosed(
      packet,
      async (outputRoot) => ({
        verdictPath: join(outputRoot, 'verdicts', `${packet.id}.md`),
        bundleDir: join(outputRoot, 'bundles', packet.id),
      }),
      /artifact_not_materialized/,
    );
  });

  it('rejects a canonical coordinate that links out of the tree', async () => {
    const packet = makePacket({ id: 'hlr-linked-verdicts' });
    writeFileSync(join(outside, `${packet.id}.md`), '# lives outside\n');

    await assertFailsClosed(
      packet,
      async (outputRoot) => {
        const bundleDir = join(outputRoot, 'bundles', packet.id);
        mkdirSync(bundleDir, { recursive: true });
        symlinkSync(outside, join(outputRoot, 'verdicts'), 'dir');
        return { verdictPath: join(outputRoot, 'verdicts', `${packet.id}.md`), bundleDir };
      },
      /artifact_not_materialized: .*resolves outside the artifact/,
    );
  });

  it('rejects a bundle coordinate that is not a directory', async () => {
    const packet = makePacket({ id: 'hlr-bundle-is-file' });

    await assertFailsClosed(
      packet,
      async (outputRoot) => {
        const verdictPath = join(outputRoot, 'verdicts', `${packet.id}.md`);
        const bundleDir = join(outputRoot, 'bundles', packet.id);
        mkdirSync(dirname(verdictPath), { recursive: true });
        mkdirSync(dirname(bundleDir), { recursive: true });
        writeFileSync(verdictPath, '# Verdict\n');
        writeFileSync(bundleDir, 'not a directory');
        return { verdictPath, bundleDir };
      },
      /artifact_not_materialized: .*is not a directory/,
    );
  });

  it('holds child verdicts to the same coordinates and materialization', async () => {
    const packet = makePacket({ id: 'hlr-parent' });
    const write = writingGenerator(packet);
    const child = (outputRoot, overrides) => ({
      verdictId: 'hlr-parent-child-1',
      findingKey: 'finding-1',
      verdictPath: join(outputRoot, 'verdicts', 'hlr-parent-child-1.md'),
      bundleDir: join(outputRoot, 'bundles', 'hlr-parent-child-1'),
      findingArtifactRef: 'ref',
      findingArtifactSha256: '0'.repeat(64),
      packet: {},
      ...overrides,
    });

    await assertFailsClosed(
      packet,
      async (outputRoot) => ({
        ...(await write(outputRoot)),
        childArtifacts: [child(outputRoot, { bundleDir: outside })],
      }),
      /artifact_coordinate_mismatch: generator returned child verdict 'hlr-parent-child-1' bundle/,
    );
    await assertFailsClosed(
      packet,
      async (outputRoot) => ({ ...(await write(outputRoot)), childArtifacts: [child(outputRoot, {})] }),
      /artifact_not_materialized: verdict 'hlr-parent-child-1' markdown/,
    );
  });

  it('rejects replay inputs staged outside the artifact and accepts them inside it', async () => {
    const packet = makePacket({ id: 'hlr-replay-inputs' });
    const write = writingGenerator(packet);

    await assertFailsClosed(
      packet,
      async (outputRoot) => ({ ...(await write(outputRoot)), extraStagedPaths: [outside] }),
      /artifact_coordinate_mismatch: staged path/,
    );

    const publisher = createLocalArtifactPublisher({ artifactRoot });
    const ref = await publisher.publishArtifact(
      publishOpts(packet, async (outputRoot) => {
        const rawInputDir = join(outputRoot, '..', '..', 'generated', 'replay', packet.id);
        mkdirSync(rawInputDir, { recursive: true });
        writeFileSync(join(rawInputDir, 'input.json'), '{}');
        return { ...(await write(outputRoot)), extraStagedPaths: [rawInputDir] };
      }),
    );
    const artifactDir = expectedArtifactDir(artifactRoot, OWNER, 'eval-harness-ledger', packet.id);
    assert.equal(existsSync(ref.verdictPath), true);
    assert.equal(existsSync(join(artifactDir, 'generated', 'replay', packet.id, 'input.json')), true);
  });

  it('withdraws the artifact when the canonical files are missing after the rename', async (t) => {
    const packet = makePacket({ id: 'hlr-post-rename' });
    const originalRename = fs.renameSync;
    // Simulate the files disappearing between the staged check and the rename.
    // The publisher binds `renameSync` through its ESM import, so the patch is
    // synced into builtin ESM exports and restored after the test.
    fs.renameSync = (from, to) => {
      originalRename(from, to);
      rmSync(join(to, 'docs', 'harness-feedback', 'verdicts', `${packet.id}.md`));
    };
    syncBuiltinESMExports();
    t.after(() => {
      fs.renameSync = originalRename;
      syncBuiltinESMExports();
    });

    await assertFailsClosed(
      packet,
      writingGenerator(packet),
      /artifact_not_materialized: verdict 'hlr-post-rename' markdown/,
    );
  });
});
