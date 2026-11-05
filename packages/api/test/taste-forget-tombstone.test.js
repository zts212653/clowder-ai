import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { TasteMemoryProjectionWriter } from '../dist/domains/memory/taste/TasteMemoryProjectionWriter.js';

// Pure projection recovery coverage; real Git/hook commits live in taste-hard-forget-hooks.
for (const visibility of ['public', 'private']) {
  for (const indent of [undefined, 2]) {
    test(`${visibility} forget recovers an existing ${indent ? 'formatted' : 'legacy compact'} tombstone unchanged`, async () => {
      const fixture = createTombstoneFixture(visibility, indent);
      try {
        const { writer, input, root, path, bytes } = fixture;
        assert.equal((await writer.apply(input)).status, 'forgotten');
        assert.equal((await writer.apply(input)).status, 'forgotten');
        assert.equal(readFileSync(join(root, path), 'utf8'), bytes);
        assert.equal(existsSync(join(root, input.sourcePath)), false);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
  test(`${visibility} legacy recovery still requires the exact owner, request, source, revision and payload`, async () => {
    const fixture = createTombstoneFixture(visibility);
    try {
      for (const patch of [
        { ownerDigest: 'other-owner' },
        { requestId: 'other-request' },
        { expectedRevision: 'other-revision' },
        { sourcePath: 'other-source' },
        { kind: 'other-kind' },
        { v: 2 },
        { extra: true },
      ]) {
        writeFileSync(
          join(fixture.root, fixture.path),
          `${JSON.stringify({ ...JSON.parse(fixture.bytes), ...patch })}\n`,
        );
        await assert.rejects(fixture.writer.apply(fixture.input), { code: 'not_available' });
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

function createTombstoneFixture(visibility, indent) {
  const root = mkdtempSync(join(tmpdir(), 'f221-legacy-tombstone-'));
  const sourcePath = visibility === 'public' ? 'docs/taste/vignettes/legacy.md' : 'private/taste/legacy.md';
  const digest = createHash('sha256').update(sourcePath).digest('hex');
  const path = `${visibility === 'public' ? 'docs/taste/tombstones' : 'private/taste/.tombstones'}/${digest}.json`;
  const input = {
    ownerUserId: 'legacy-owner',
    sourcePath,
    command: {
      action: 'hard_forget',
      requestId: 'legacy-request',
      expectedRevision: `sha256:${'a'.repeat(64)}`,
      confirmed: true,
    },
    recordTargetRevision() {},
  };
  const bytes = `${JSON.stringify(
    {
      v: 1,
      kind: 'taste-memory-forget-tombstone',
      ownerDigest: createHash('sha256').update(input.ownerUserId).digest('hex'),
      sourcePath,
      requestId: input.command.requestId,
      expectedRevision: input.command.expectedRevision,
    },
    null,
    indent,
  )}\n`;
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
  const writer = new TasteMemoryProjectionWriter(
    {
      canonicalRoot: () => root,
      gitCheckoutRoot: () => root,
      approvalLockKey: () => 'legacy-test',
    },
    {
      publishProjection: async (projection) => {
        const result = projection.materialize(root);
        return { commitSha: 'a'.repeat(40), alreadyPublished: result === 'already-published' };
      },
    },
  );
  return { root, path, bytes, input, writer };
}
