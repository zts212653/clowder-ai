import assert from 'node:assert/strict';
import { readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { getRichBlockBuffer } from '../src/domains/cats/services/agents/invocation/RichBlockBuffer.js';
import {
  collectiveDocumentFileName,
  isCollectiveDocumentFile,
} from '../src/infrastructure/document/collective-document-scope.js';
import { documentWriterFixture } from './f290-communication-document-writer.fixture.js';
import { CAT } from './f290-communication-validation.host.js';

const payload = { markdown: '# Current Work\nA bounded document.\n', format: 'md', baseName: 'work-guide' };

test('authenticated current Work MD writer mints its own namespace and replays one immutable asset and block', async () => {
  const f = await documentWriterFixture();
  try {
    const expected = collectiveDocumentFileName(f.scope, Buffer.from(payload.markdown));
    const first = await f.post(payload);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().url, `/uploads/${expected}`);
    assert.deepEqual(await readFile(join(f.uploadDir, expected)), Buffer.from(payload.markdown));
    const second = await f.post({ ...payload, baseName: 'cannot-change-the-asset-address' });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().url, first.json().url);
    assert.deepEqual(await readdir(f.uploadDir), [expected]);
    const blocks = getRichBlockBuffer().consume(f.task.threadId, CAT, f.auth.invocationId, { final: false });
    assert.equal(blocks.length, 1);
    assert.equal(f.broadcasts.length, 1);
    assert.equal(isCollectiveDocumentFile(f.scope, expected, Buffer.from(payload.markdown)), true);
    assert.equal(isCollectiveDocumentFile({ ...f.scope, taskId: 'another-Task' }, expected), false);
  } finally {
    await f.close();
  }
});

test('scope comes only from the authenticated Work binding and public participation cannot generate documents', async () => {
  const f = await documentWriterFixture();
  try {
    const sibling = f.tasks.create({
      userId: f.cafe.ownerUserId,
      threadId: f.task.threadId,
      title: 'Sibling Task',
      why: 'scope canary',
      createdBy: CAT,
      ownerCatId: CAT,
    });
    const injected = await f.post({ ...payload, taskId: sibling.id });
    assert.equal(injected.statusCode, 403);
    const response = await f.post({
      ...payload,
      userId: 'sibling-owner',
      executionRevision: 999,
      scope: { ...f.scope, taskId: sibling.id },
      baseName: `cwork-for-sibling-${sibling.id}`,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().url, `/uploads/${collectiveDocumentFileName(f.scope, Buffer.from(payload.markdown))}`);
    const publicResponse = await f.post(payload, await f.publicAuth());
    assert.equal(publicResponse.statusCode, 403, publicResponse.body);
    assert.equal(publicResponse.json().reason, 'collective_participation_tool_policy');
  } finally {
    await f.close();
  }
});

test('Work MD producer denies PDF, oversized UTF8 and binary NUL before rendering', async () => {
  const f = await documentWriterFixture();
  try {
    let renderCount = 0;
    f.hooks.afterRender = async () => {
      renderCount += 1;
    };
    for (const bad of [
      { ...payload, format: 'pdf' },
      { ...payload, format: 'docx' },
      { ...payload, markdown: '中'.repeat(22_000) },
      { ...payload, markdown: 'binary\0text' },
    ]) {
      const response = await f.post(bad);
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().code, 'WORK_DOCUMENT_CONTENT_UNSUPPORTED');
    }
    assert.equal(renderCount, 0);
    assert.deepEqual(await readdir(f.uploadDir), []);
    assert.equal(f.broadcasts.length, 0);
    assert.deepEqual(getRichBlockBuffer().consume(f.task.threadId, CAT, f.auth.invocationId, { final: false }), []);
  } finally {
    await f.close();
  }
});

test('an existing conflicting or symlink asset is never overwritten or published', async () => {
  const f = await documentWriterFixture();
  try {
    const name = collectiveDocumentFileName(f.scope, Buffer.from(payload.markdown));
    await writeFile(join(f.uploadDir, name), 'conflicting existing bytes');
    const conflict = await f.post(payload);
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal(await readFile(join(f.uploadDir, name), 'utf8'), 'conflicting existing bytes');
    const otherPayload = { ...payload, markdown: '# A different body\n' };
    const otherName = collectiveDocumentFileName(f.scope, Buffer.from(otherPayload.markdown));
    await symlink(join(f.uploadDir, name), join(f.uploadDir, otherName));
    const linked = await f.post(otherPayload);
    assert.equal(linked.statusCode, 409, linked.body);
    assert.ok(!linked.body.includes(f.uploadDir), 'HTTP does not reveal a private filesystem root');
    assert.equal(await readFile(join(f.uploadDir, name), 'utf8'), 'conflicting existing bytes');
    assert.equal(f.broadcasts.length, 0);
  } finally {
    await f.close();
  }
});

test('revocation after real rendering blocks publication and removes only newly created bytes', async () => {
  const f = await documentWriterFixture();
  try {
    f.hooks.afterRender = () =>
      f.cafe.connector.revokeWorkGrants(f.cafe.connectionId, f.cafe.ownerUserId, ['grant-guides']);
    const response = await f.post(payload);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, 'WORK_DOCUMENT_AUTHORITY_CHANGED');
    assert.deepEqual(await readdir(f.uploadDir), []);
    assert.equal(f.broadcasts.length, 0);
    assert.deepEqual(getRichBlockBuffer().consume(f.task.threadId, CAT, f.auth.invocationId, { final: false }), []);
  } finally {
    await f.close();
  }
});

test('a failed fresh authority check on replay preserves a previously accepted immutable asset', async () => {
  const f = await documentWriterFixture();
  try {
    const accepted = await f.post(payload);
    assert.equal(accepted.statusCode, 200, accepted.body);
    getRichBlockBuffer().consume(f.task.threadId, CAT, f.auth.invocationId, { final: false });
    f.hooks.afterRender = () =>
      f.cafe.connector.revokeWorkGrants(f.cafe.connectionId, f.cafe.ownerUserId, ['grant-guides']);
    const failed = await f.post(payload);
    assert.equal(failed.statusCode, 409, failed.body);
    const name = collectiveDocumentFileName(f.scope, Buffer.from(payload.markdown));
    assert.deepEqual(await readFile(join(f.uploadDir, name)), Buffer.from(payload.markdown));
    assert.equal(f.broadcasts.length, 1);
    assert.deepEqual(getRichBlockBuffer().consume(f.task.threadId, CAT, f.auth.invocationId, { final: false }), []);
  } finally {
    await f.close();
  }
});

test('ordinary home document generation retains its existing filename and format path', async () => {
  const f = await documentWriterFixture();
  try {
    const home = await f.registry.create(f.cafe.ownerUserId, CAT, f.endpoint.id);
    const response = await f.post({ ...payload, baseName: 'home-guide' }, home);
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.json().url, /^\/uploads\/doc-[a-f0-9]{12}-home-guide\.md$/);
    assert.equal(response.json().fileName, 'home-guide.md');
    getRichBlockBuffer().consume(f.endpoint.id, CAT, home.invocationId);
  } finally {
    await f.close();
  }
});

test('publication fence preserves an authorized same-Task relay when the creating invocation is replaced after copy', async () => {
  const f = await documentWriterFixture();
  try {
    const relay = await f.relayAuth();
    let announceCopy: (() => void) | undefined;
    let releaseCreator: (() => void) | undefined;
    const copied = new Promise<void>((resolve) => {
      announceCopy = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCreator = resolve;
    });
    f.hooks.beforeVerify = async (record, count) => {
      if (record.invocationId === f.auth.invocationId && count === 2) {
        announceCopy?.();
        await release;
      }
    };
    const creatorResponse = f.post(payload);
    await copied;
    const name = collectiveDocumentFileName(f.scope, Buffer.from(payload.markdown));
    assert.deepEqual(
      await readFile(join(f.uploadDir, name)),
      Buffer.from(payload.markdown),
      'creator already copied bytes',
    );
    const relayResponse = f.post(payload, relay);
    const record = await f.registry.getRecord(f.auth.invocationId);
    assert.ok(record?.collectiveWorkBinding);
    await f.registry.create(
      record.userId,
      CAT,
      record.threadId,
      undefined,
      undefined,
      record.toolExecutionPolicy,
      record.originTriggerMessageId,
      'unknown',
      undefined,
      undefined,
      record.collectiveWorkBinding,
    );
    releaseCreator?.();
    const [creator, acceptedRelay] = await Promise.all([creatorResponse, relayResponse]);
    assert.equal(creator.statusCode, 409, creator.body);
    assert.equal(acceptedRelay.statusCode, 200, acceptedRelay.body);
    assert.equal(acceptedRelay.json().url, `/uploads/${name}`);
    assert.deepEqual(await readFile(join(f.uploadDir, name)), Buffer.from(payload.markdown));
    assert.equal(f.broadcasts.length, 1);
    assert.deepEqual(getRichBlockBuffer().consume(f.task.threadId, CAT, f.auth.invocationId, { final: false }), []);
    assert.equal(getRichBlockBuffer().consume(f.task.threadId, relay.catId, relay.invocationId).length, 1);
  } finally {
    await f.close();
  }
});
