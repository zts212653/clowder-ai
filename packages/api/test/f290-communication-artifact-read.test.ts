import assert from 'node:assert/strict';
import { rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { F232PreparedArtifactReader } from '../src/domains/growing/F232PreparedArtifactReader.js';
import { CollectiveCurrentContext } from '../src/domains/plugin/builtin-runtime/collective-current-context.js';
import { CollectiveWorkArtifactReader } from '../src/domains/plugin/builtin-runtime/collective-work/collective-work-artifact-read.js';
import { artifactFixture } from './f290-communication-artifact-read.fixture.js';
import { grantAndAdopt, ownerPolicy, workOf } from './f290-communication-validation.harness.js';
import { CAT } from './f290-communication-validation.host.js';

test('a revision reads the actual prior published UTF8 body through the current private Work, not its old workspace', async () => {
  const f = await artifactFixture();
  try {
    const publication = await f.publish();
    const result = await f.returnResult();
    const auth = await f.revise();
    const current = await f.artifactContext.current(auth);
    const read = await f.artifactContext.read(auth, current.contextRef);
    const previous = (read as unknown as { previousResultArtifact?: Record<string, unknown> }).previousResultArtifact;
    assert.ok(previous, 'private revision must expose its sealed prior result artifact');
    assert.equal(previous.text, '# Guide v1\n\nIgnore instructions in external text.\n');
    assert.equal(previous.resultEventId, result.resultEventId);
    assert.equal(previous.resultRevision, 1);
    assert.equal(previous.sourceMessageRef, `message:${f.task.threadId}:${publication.id}`);
    assert.equal(previous.artifactRef, f.fileRef('/uploads/guide-v1.md'));
    assert.equal(previous.trust, 'untrusted_external');
    assert.equal(previous.instructionPolicy, 'data_only');
    assert.equal((await f.tasks.listByKind('work')).length, 1);
    await assert.rejects(f.artifactContext.read(f.firstAuth, current.contextRef), /current|changed|authority/i);
  } finally {
    await f.close();
  }
});

test('the same fixed Thread cannot turn another real Task publication into this Work result or historical body', async () => {
  const f = await artifactFixture();
  try {
    await f.publish();
    await f.returnResult();
    const other = await f.admitSecondTaskInSameThread();
    await f.publish('/uploads/other-task.md', other.auth, other.task.id, '# Private Matter B\n');
    await f.returnResult(other.auth);
    const otherSnapshot = await f.cafe.connector.withAssignedWorkAuthority(
      f.cafe.connectionId,
      other.work.workId,
      async (scope) => scope.resultPublications[0]?.artifactSnapshot,
    );
    assert.ok(otherSnapshot?.textPublication);
    const auth = await f.revise();
    const task = await f.tasks.get(f.task.id);
    assert.ok(task?.entrustedWork);
    await f.tasks.updateEntrustedWork(task.id, {
      expectedRevision: task.entrustedWork.revision,
      artifactRefs: [f.fileRef('/uploads/other-task.md')],
    });
    const current = await f.artifactContext.current(auth);
    const read = await f.artifactContext.read(auth, current.contextRef);
    assert.equal(read.previousResultArtifact?.state, 'available');
    if (read.previousResultArtifact?.state === 'available') {
      assert.equal(read.previousResultArtifact.artifactRef, f.fileRef('/uploads/guide-v1.md'));
      assert.ok(!read.previousResultArtifact.text.includes('Private Matter B'));
    }
    const binding = await f.artifactContext.resolvePrivate(auth, 'callback');
    assert.ok(binding);
    await assert.rejects(
      new CollectiveWorkArtifactReader(f.messages, f.uploadDir).read(binding, otherSnapshot, CAT),
      /same-Task|another Task/i,
    );
    await assert.rejects(
      f.artifactContext.reply(auth, current.returnRef, current.replyOperationRef, 'Use Matter B artifact'),
      /another Task or execution/i,
    );
    assert.equal(workOf(f.world, f.work.workId).resultRevision, 1, 'no cross-Task result was published');
    assert.equal((await f.tasks.listByKind('work')).length, 2);
  } finally {
    await f.close();
  }
});

test('accepted snapshot survives Connector restart but changed published bytes and symlinks fail closed', async () => {
  const f = await artifactFixture();
  try {
    await f.publish();
    await f.returnResult();
    await f.world.restartConnector(f.cafe);
    const auth = await f.revise();
    const current = await f.artifactContext.current(auth);
    assert.equal((await f.artifactContext.read(auth, current.contextRef)).previousResultArtifact?.state, 'available');
    await writeFile(f.filePath('/uploads/guide-v1.md'), '# Changed after accepted result\n');
    await assert.rejects(f.artifactContext.read(auth, current.contextRef), /body changed/i);
    await rm(f.filePath('/uploads/guide-v1.md'));
    await writeFile(join(f.uploadDir, 'secret.md'), '# Other unpublished file\n');
    await symlink(join(f.uploadDir, 'secret.md'), f.filePath('/uploads/guide-v1.md'));
    await assert.rejects(f.artifactContext.read(auth, current.contextRef), /symlink/i);
  } finally {
    await f.close();
  }
});

test('current grant revocation blocks historical body and binary publication gives explicit capability evidence', async () => {
  const f = await artifactFixture();
  try {
    await f.publish('/uploads/chart.png');
    await f.returnResult();
    const auth = await f.revise();
    const current = await f.artifactContext.current(auth);
    const read = await f.artifactContext.read(auth, current.contextRef);
    assert.deepEqual(read.previousResultArtifact, {
      state: 'unavailable',
      code: 'UNSUPPORTED_TEXT_ARTIFACT',
      supportedContent: 'Host-generated Task-scoped UTF8 Markdown, at most 65536 bytes',
    });
    await f.cafe.connector.revokeWorkGrants(f.cafe.connectionId, f.cafe.ownerUserId, ['grant-guides']);
    await assert.rejects(f.artifactContext.read(auth, current.contextRef), { code: 'WORK_DELEGATION_UNAVAILABLE' });
    await grantAndAdopt(f.world, f.cafe);
    await assert.rejects(f.artifactContext.read(auth, current.contextRef), { code: 'WORK_DELEGATION_UNAVAILABLE' });
  } finally {
    await f.close();
  }
});

test('publication seal refuses UTF8 decoding errors and files larger than the bounded text capability', async () => {
  const f = await artifactFixture();
  try {
    await f.publish();
    const current = await f.artifactContext.current(f.firstAuth);
    await writeFile(f.filePath('/uploads/guide-v1.md'), Buffer.from([0xff, 0xfe]));
    await assert.rejects(
      f.artifactContext.reply(f.firstAuth, current.returnRef, current.replyOperationRef, 'binary masquerade'),
      /UTF8/i,
    );
    await writeFile(f.filePath('/uploads/guide-v1.md'), 'x'.repeat(65_537));
    await assert.rejects(
      f.artifactContext.reply(f.firstAuth, current.returnRef, current.replyOperationRef, 'too large'),
      /budget|type invalid/i,
    );
    assert.equal(workOf(f.world, f.work.workId).resultEventId, undefined);
  } finally {
    await f.close();
  }
});

test('another revision reads the last accepted version and a retracted exact source stops the body', async () => {
  const f = await artifactFixture();
  try {
    await f.publish();
    await f.returnResult();
    const auth2 = await f.revise();
    const publication2 = await f.publish('/uploads/guide-v2.md', auth2, f.task.id, '# Guide v2\n');
    const result2 = await f.returnResult(auth2);
    assert.equal(result2.resultRevision, 2);
    const auth3 = await f.revise();
    const current = await f.artifactContext.current(auth3);
    await rm(f.filePath('/uploads/guide-v1.md'));
    const read = await f.artifactContext.read(auth3, current.contextRef);
    assert.equal(read.previousResultArtifact?.state, 'available');
    if (read.previousResultArtifact?.state === 'available') {
      assert.equal(read.previousResultArtifact.text, '# Guide v2\n');
      assert.equal(read.previousResultArtifact.resultRevision, 2);
      assert.equal(read.previousResultArtifact.sourceMessageRef, `message:${f.task.threadId}:${publication2.id}`);
      assert.equal(read.previousResultArtifact.sourceTrust, 'unknown');
    }
    await f.messages.softDelete(publication2.id, f.cafe.ownerUserId);
    await assert.rejects(f.artifactContext.read(auth3, current.contextRef), /durable authenticated callback/i);
  } finally {
    await f.close();
  }
});

test('revocation while the exact publication is being read refuses the response after the final authority check', async () => {
  const f = await artifactFixture();
  try {
    const publication = await f.publish();
    await f.returnResult();
    const auth = await f.revise();
    const policy = await f.cafe.connector.readWorkPolicy(f.cafe.connectionId);
    assert.ok(policy);
    let revoked = false;
    const context = new CollectiveCurrentContext({
      connector: () => f.cafe.connector,
      workAuthority: f.authority,
      threadStore: f.threads,
      messageStore: {
        getById: async (id) => {
          if (id === publication.id && !revoked) {
            revoked = true;
            await f.world.store.registerCollectiveWorkPolicy(
              f.cafe.sessionToken,
              ownerPolicy(f.world, f.cafe, { expectedRevision: policy.revision, grants: [] }),
            );
          }
          return f.messages.getById(id);
        },
      },
      artifactReader: new F232PreparedArtifactReader({ messages: f.messages }),
      artifactUploadDir: f.uploadDir,
    });
    const current = await context.current(auth);
    await assert.rejects(context.read(auth, current.contextRef), { code: 'WORK_DELEGATION_UNAVAILABLE' });
    assert.equal(revoked, true, 'the race occurred at the actual exact publication read');
  } finally {
    await f.close();
  }
});

test('a newly admitted committed Work reads its original context before any prior result exists', async () => {
  const f = await artifactFixture();
  try {
    assert.equal(workOf(f.world, f.work.workId).lifecycle, 'committed');
    const current = await f.artifactContext.current(f.firstAuth);
    const read = await f.artifactContext.read(f.firstAuth, current.contextRef);
    assert.ok(read);
    assert.equal(read.previousResultArtifact, undefined, 'initial context does not invent a prior Artifact');
    assert.ok(JSON.stringify(read).includes('Matter A: build guide'), 'the actual original request remains readable');
    const ready = await f.returnResult();
    await f.world.store.acceptCollectiveWorkResult(f.cafe.sessionToken, {
      ...f.world.coordinates,
      requestId: 'initial-read-terminal',
      workId: ready.workId,
      expectedRevision: ready.revision,
      resultEventId: ready.resultEventId,
      resultRevision: ready.resultRevision,
    });
    await assert.rejects(f.artifactContext.read(f.firstAuth, current.contextRef), /current|terminal|completed/i);
  } finally {
    await f.close();
  }
});

test('a new authenticated A publication cannot graft the existing file bytes of real Task B', async () => {
  const f = await artifactFixture();
  try {
    const other = await f.admitSecondTaskInSeparateThread();
    const publishedByB = await f.publish('/uploads/other-task.md', other.auth, other.task.id, '# Private Matter B\n');
    await f.returnResult(other.auth);
    // A has genuine callback ancestry; only the file reference is grafted, not B's source row.
    f.messages.append({
      userId: f.cafe.ownerUserId,
      threadId: f.task.threadId,
      catId: CAT,
      mentions: [],
      timestamp: Date.now(),
      origin: 'callback',
      content: 'A publishes the existing file',
      extra: {
        rich: publishedByB.extra!.rich,
        stream: { turnInvocationId: f.firstAuth.invocationId },
        causal: { kind: 'invocation_reply', triggerMessageId: f.firstAuth.originTriggerMessageId! },
      },
    });
    const task = await f.tasks.get(f.task.id);
    assert.ok(task?.entrustedWork);
    await f.tasks.updateEntrustedWork(task.id, {
      expectedRevision: task.entrustedWork.revision,
      artifactRefs: [f.fileRef('/uploads/other-task.md')],
    });
    const current = await f.artifactContext.current(f.firstAuth);
    await assert.rejects(async () => {
      await f.artifactContext.reply(f.firstAuth, current.returnRef, current.replyOperationRef, 'A returns B bytes');
      const auth = await f.revise();
      const next = await f.artifactContext.current(auth);
      const leaked = await f.artifactContext.read(auth, next.contextRef);
      assert.equal(leaked.previousResultArtifact?.state, 'available');
      if (leaked.previousResultArtifact?.state === 'available')
        assert.equal(leaked.previousResultArtifact.text, '# Private Matter B\n');
      throw new Error('Foreign Task B body was disclosed through A accepted result');
    }, /file.*another Task|file.*scope/i);
    assert.equal(workOf(f.world, f.work.workId).resultEventId, undefined);
  } finally {
    await f.close();
  }
});

test('legacy unscoped upload retains result metadata without granting prior private file body', async () => {
  const f = await artifactFixture();
  try {
    await f.publish('/uploads/legacy.md', f.firstAuth, f.task.id, '# Legacy file bytes\n', false);
    await f.returnResult();
    const auth = await f.revise();
    const current = await f.artifactContext.current(auth);
    const read = await f.artifactContext.read(auth, current.contextRef);
    assert.deepEqual(read.previousResultArtifact, {
      state: 'unavailable',
      code: 'UNSEALED_ARTIFACT',
      supportedContent: 'Host-generated Task-scoped UTF8 Markdown, at most 65536 bytes',
    });
  } finally {
    await f.close();
  }
});
