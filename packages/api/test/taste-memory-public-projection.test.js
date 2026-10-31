import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { SessionMutex } from '../dist/domains/cats/services/agents/invocation/SessionMutex.js';
import {
  InMemoryOwnerMemoryActionReceiptStore,
  OwnerMemoryActionCoordinator,
} from '../dist/domains/memory/owner/OwnerMemoryActionCoordinator.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { TasteMemoryLifecycleService } from '../dist/domains/memory/taste/TasteMemoryLifecycleService.js';
import { TasteMemoryLifecycleStore } from '../dist/domains/memory/taste/TasteMemoryLifecycleStore.js';
import { TasteMemoryProjectionWriter } from '../dist/domains/memory/taste/TasteMemoryProjectionWriter.js';
import { tasteDocumentAnchor, tasteMemoryId } from '../dist/domains/memory/taste/taste-memory-identity.js';
import { TastePublicationIndeterminateError } from '../dist/domains/taste/services/GitTastePublisher.js';

const ownerUserId = 'public-taste-owner';
const sourcePath = 'docs/taste/vignettes/public-lifecycle.md';
const initialContent =
  '---\nwhen: 2026-10-06\nquotes: ["Public quote"]\nscene: "Public scene"\ntags: ["public"]\ndimension: visual-quality\nprivacy: public\n---\n';

const revisionOf = (content) => `sha256:${createHash('sha256').update(content).digest('hex')}`;

describe('F321 public Taste projection', () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'f321-public-taste-'));
    roots.push(root);
    mkdirSync(join(root, 'docs/taste/vignettes'), { recursive: true });
    writeFileSync(join(root, sourcePath), initialContent, 'utf8');
    writeFileSync(
      join(root, 'docs/taste/index.md'),
      '# Taste Index\n\n- [**public**](vignettes/public-lifecycle.md)\n  - 搜索词：public\n  - 场景：Public scene\n',
      'utf8',
    );
    return {
      root,
      repository: {
        canonicalRoot: () => root,
        gitCheckoutRoot: () => root,
        approvalLockKey: () => 'public-taste-test',
      },
    };
  }

  it('records the target revision before publishing and removes public canonical/index content on forget', async () => {
    assert.equal(tasteDocumentAnchor(sourcePath), 'doc:taste/vignettes/public-lifecycle');
    const { root, repository } = fixture();
    const publicationStates = [];
    const writer = new TasteMemoryProjectionWriter(repository, {
      publishProjection: async (input) => {
        const state = input.materialize(root);
        publicationStates.push(state);
        return { commitSha: 'a'.repeat(40), alreadyPublished: state === 'already-published' };
      },
    });
    const initialRevision = revisionOf(initialContent);
    let recordedRevision;
    const corrected = await writer.apply({
      ownerUserId,
      sourcePath,
      command: {
        action: 'correct',
        requestId: 'public-correct:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
        expectedRevision: initialRevision,
        patch: { scene: 'Corrected public scene' },
      },
      recordTargetRevision: (revision) => {
        assert.equal(readFileSync(join(root, sourcePath), 'utf8'), initialContent);
        recordedRevision = revision;
      },
    });
    assert.equal(corrected.revision, recordedRevision);
    assert.match(readFileSync(join(root, 'docs/taste/index.md'), 'utf8'), /Corrected public scene/u);

    const retired = await writer.apply({
      ownerUserId,
      sourcePath,
      command: {
        action: 'retire',
        requestId: 'public-retire:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
        expectedRevision: corrected.revision,
      },
      recordTargetRevision: () => {},
    });
    assert.equal(retired.status, 'retired');
    assert.equal(readFileSync(join(root, 'docs/taste/index.md'), 'utf8').includes('public-lifecycle.md'), false);

    const forgetCommand = {
      action: 'hard_forget',
      requestId: 'public-forget:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
      expectedRevision: retired.revision,
      confirmed: true,
    };
    const forgotten = await writer.apply({
      ownerUserId,
      sourcePath,
      command: forgetCommand,
      recordTargetRevision: (revision) => {
        assert.equal(revision, null);
        assert.equal(existsSync(join(root, sourcePath)), true);
      },
    });
    assert.deepEqual(forgotten, { sourcePath, revision: null, status: 'forgotten' });
    assert.equal(existsSync(join(root, sourcePath)), false);
    const tombstoneName = `${createHash('sha256').update(sourcePath).digest('hex')}.json`;
    const tombstone = readFileSync(join(root, 'docs/taste/tombstones', tombstoneName), 'utf8');
    assert.equal(tombstone.includes(ownerUserId), false);
    assert.equal(JSON.parse(tombstone).ownerDigest, createHash('sha256').update(ownerUserId).digest('hex'));
    assert.deepEqual(publicationStates, ['changed', 'changed', 'changed']);

    const replay = await writer.apply({
      ownerUserId,
      sourcePath,
      command: forgetCommand,
      recordTargetRevision: () => {},
    });
    assert.equal(replay.status, 'forgotten');
    assert.equal(publicationStates.at(-1), 'already-published');
  });

  it('recovers an indeterminate public push from exact prepared evidence without applying twice', async () => {
    const { root, repository } = fixture();
    let publications = 0;
    const writer = new TasteMemoryProjectionWriter(repository, {
      publishProjection: async (input) => {
        publications++;
        const state = input.materialize(root);
        if (publications === 1) throw new TastePublicationIndeterminateError('push acknowledgement lost');
        return { commitSha: 'b'.repeat(40), alreadyPublished: state === 'already-published' };
      },
    });
    const db = new Database(':memory:');
    applyMigrations(db);
    const store = new TasteMemoryLifecycleStore(db);
    const lifecycle = new TasteMemoryLifecycleService({
      store,
      writer,
      coordinator: new OwnerMemoryActionCoordinator({
        store: new InMemoryOwnerMemoryActionReceiptStore(),
        lock: new SessionMutex(),
      }),
      targetLock: new SessionMutex(),
      lockKey: repository.approvalLockKey,
      invalidateDerived: async () => {},
    });
    const command = {
      action: 'correct',
      requestId: 'public-recover:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
      expectedRevision: revisionOf(initialContent),
      patch: { scene: 'Exactly once after an uncertain push' },
    };
    await assert.rejects(
      lifecycle.executeOwnerAction(ownerUserId, tasteMemoryId(sourcePath), sourcePath, command),
      /push acknowledgement lost/u,
    );
    const firstContent = readFileSync(join(root, sourcePath), 'utf8');
    const recovered = await lifecycle.executeOwnerAction(ownerUserId, tasteMemoryId(sourcePath), sourcePath, command);
    assert.equal(recovered.outcome, 'applied');
    assert.equal(readFileSync(join(root, sourcePath), 'utf8'), firstContent);
    assert.equal(publications, 2);
    db.close();
  });
});
