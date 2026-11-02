import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCollectiveMessageAttachmentOwner } from '../src/domains/collaborative-content/collective-artifact/message-attachment-owner.js';
import type { CollectiveArtifactOwnerPort } from '../src/domains/collaborative-content/collective-artifact/owner-port.js';
import { createCollectiveArtifactOwnerProxy } from '../src/domains/plugin/host-surface/collective-artifact-owner.js';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';

test('ordinary attachments use immutable content custody, without a Work or private Thread', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'collective-message-content-'));
  t.after(() => rm(directory, { recursive: true }));
  const owner = new ProjectContentOwnerService({ dataDir: join(directory, 'content') });
  let upstream: CollectiveArtifactOwnerPort | undefined = {
    attachments: createCollectiveMessageAttachmentOwner(owner),
    async execute() {
      return { status: 'error', error: { code: 'unsupported_operation' } };
    },
  };
  const port = createCollectiveArtifactOwnerProxy({ owner: () => upstream, assertCurrent: async () => {} });
  assert.ok(port.attachments, 'The approved Service needs a dedicated ordinary-attachment custody capability');
  const scope = {
    serviceInstanceId: 'svc_service01',
    collectiveId: 'col_collective01',
    humanId: 'human_remote01',
    channelId: 'general',
    attachmentId: 'att_screenshot01',
  };
  const bytes = Buffer.from('immutable attachment bytes');
  const input = {
    scope,
    fileName: '资料.txt',
    mediaType: 'text/plain',
    bytes,
    blobDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
  let active = true;
  const authority = {
    async reauthorize() {
      assert.ok(active, 'membership revoked');
      return scope;
    },
  };
  const signal = new AbortController().signal;
  const attachment = await port.attachments.retain(input, authority, signal);
  assert.deepEqual(await port.attachments.retain(input, authority, signal), attachment);
  const read = await port.attachments.open({ scope, attachment, range: 'bytes=0-8' }, authority, signal);
  assert.equal(read.status, 206);
  const chunks: Buffer[] = [];
  for await (const chunk of read.body) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), 'immutable');
  const restarted = new ProjectContentOwnerService({ dataDir: join(directory, 'content') });
  assert.equal((await restarted.load(attachment.contentRef, 1)).bytes.toString(), bytes.toString());
  await assert.rejects(
    port.attachments.open({ scope: { ...scope, humanId: 'human_foreign01' }, attachment }, authority, signal),
  );
  await assert.rejects(port.attachments.retain({ ...input, bytes: Buffer.from('changed') }, authority, signal));
  active = false;
  await assert.rejects(port.attachments.open({ scope, attachment }, authority, signal), /revoked/);
  active = true;
  upstream = undefined;
  await assert.rejects(port.attachments.open({ scope, attachment }, authority, signal), /owner_unavailable/);
});
