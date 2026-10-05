import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function guideRequest(tag) {
  return `请你为首次使用这个协作空间的人写一份三步简短指南（事项 ${tag}），以可下载的 Markdown 文件交付，最后一步要有一个具体例子。请实际接下并完成这件事，先给一条真实进度，把文件正式发布并登记为这项工作的产物，再将最终结果回给这个请求。`;
}

export const guideFeedback =
  '谢谢。请基于事项 A 刚才已经发布的 Markdown 文件继续修改：先读取上一版实际发布的正文，把指南缩短为两步，并保留上一版最后一步的具体例子。我需要一个新的可下载 Markdown 版本；请先给进度，正式发布并登记新版本，然后回给我修改后的结果。';

/** All publication witnesses come from the production writer, callback row and accepted Connector outbox. */
export async function provePublishedMarkdown(host, work, task, evidence) {
  const publications = await host.cafe.connector.withSynchronizedAssignedWorkAuthority(
    host.cafe.connectionId,
    work.assignmentEventId,
    async (scope) => scope.resultPublications,
  );
  const publication = publications.find(
    (row) => row.resultEventId === work.resultEventId && row.resultRevision === work.resultRevision,
  );
  const snapshot = publication?.artifactSnapshot;
  const seal = snapshot?.textPublication;
  assert.ok(seal, 'Result must carry a production sealed text publication, not a draft or URL claim');
  assert.equal(publication.taskRef, `task:work:${task.id}`);
  assert.equal(seal.taskId, task.id);
  assert.equal(seal.resultRevision, work.resultRevision);
  assert.equal(seal.executionRevision, work.executionAuthority.revision);
  assert.deepEqual(task.entrustedWork.artifactRefs, [snapshot.artifactRef]);
  assert.match(snapshot.artifactRef, /^\/uploads\/[A-Za-z0-9._-]+\.md$/);
  assert.equal(seal.mediaType, 'text/markdown');
  assert.ok(seal.byteLength > 0 && seal.byteLength <= 65536);
  const fileMessage = await host.messages.getById(seal.sourceMessageId);
  assert.equal(fileMessage?.origin, 'callback');
  assert.equal(fileMessage?.extra?.isExplicitPost, true);
  assert.ok(
    fileMessage?.extra?.rich?.blocks.some((block) => block.kind === 'file' && block.url === snapshot.artifactRef),
  );
  const downloadUrl = new URL(snapshot.artifactRef, host.callbackUrl);
  const download = await fetch(downloadUrl);
  assert.equal(download.status, 200, 'Published Markdown must be retrievable through the production uploads route');
  const downloadedBytes = new Uint8Array(await download.arrayBuffer());
  const downloadedDigest = `sha256:${createHash('sha256').update(downloadedBytes).digest('hex')}`;
  assert.equal(downloadedDigest, seal.contentDigest);
  assert.equal(downloadedBytes.length, seal.byteLength);
  const rows = evidence.callbacks;
  const same = (row) => row.cafe === host.cafe.label && row.invocationId === seal.invocationId && row.status === 200;
  const generation = rows.findIndex(
    (row) =>
      same(row) &&
      row.path === '/api/callbacks/generate-document' &&
      row.input?.format === 'md' &&
      row.response?.url === snapshot.artifactRef,
  );
  const posted = rows.findIndex(
    (row) =>
      same(row) && row.path === '/api/callbacks/post-message' && row.response?.messageId === seal.sourceMessageId,
  );
  const registered = rows.findIndex(
    (row) =>
      same(row) &&
      row.path === '/api/callbacks/update-entrusted-work' &&
      row.input?.taskId === task.id &&
      row.input?.artifactRefs?.includes(snapshot.artifactRef),
  );
  const refreshed = rows.findIndex(
    (row, index) => index > registered && same(row) && row.path === '/api/callbacks/collective-current-context',
  );
  const replied = rows.findIndex(
    (row, index) => index > refreshed && same(row) && row.path === '/api/callbacks/collective-reply',
  );
  assert.ok(
    generation >= 0 && posted > generation && registered > posted && refreshed > registered && replied > refreshed,
    'Real model must generate, explicitly publish, register Artifact refs, refresh authority and return result in order',
  );
  return {
    publication,
    download: {
      url: downloadUrl.href,
      status: download.status,
      contentType: download.headers.get('content-type'),
      byteLength: downloadedBytes.length,
      contentDigest: downloadedDigest,
    },
    callbackOrder: { generation, posted, registered, refreshed, replied },
    sourceMessageId: fileMessage.id,
    threadId: task.threadId,
  };
}

export function provePriorArtifactRead(host, prior, current, evidence) {
  const currentSeal = current.publication.artifactSnapshot.textPublication;
  const snapshot = prior.publication.artifactSnapshot;
  const seal = snapshot.textPublication;
  const read = evidence.callbacks.find(
    (row) =>
      row.cafe === host.cafe.label &&
      row.invocationId === currentSeal.invocationId &&
      row.path === '/api/callbacks/collective-read-context' &&
      row.status === 200 &&
      row.response?.previousResultArtifact?.state === 'available',
  );
  const body = read?.response?.previousResultArtifact;
  assert.ok(body, 'v2 must actually read the previously accepted v1 publication through the production callback');
  assert.equal(body.artifactRef, snapshot.artifactRef);
  assert.equal(body.resultEventId, prior.publication.resultEventId);
  assert.equal(body.resultRevision, prior.publication.resultRevision);
  assert.equal(body.contentDigest, seal.contentDigest);
  assert.equal(body.contentDigest, `sha256:${createHash('sha256').update(body.text).digest('hex')}`);
  assert.equal(body.sourceMessageRef, `message:${prior.threadId}:${seal.sourceMessageId}`);
  assert.equal(body.trust, 'untrusted_external');
  assert.equal(body.sourceTrust, 'unknown');
  assert.notEqual(current.publication.artifactSnapshot.artifactRef, snapshot.artifactRef);
  return {
    invocationId: read.invocationId,
    previousResultArtifact: body,
    source: 'actual production read-context response; no old draft filesystem read',
  };
}

export async function originalChannelResult(world, work, catId) {
  const events = await world.store.listEventsForHuman(world.a.sessionToken, world.coordinates.collectiveId);
  const event = events.find((row) => row.eventId === work.resultEventId);
  assert.ok(event?.body);
  assert.equal(event.actor.kind, 'agent');
  assert.equal(event.actor.agent.agentId, catId);
  assert.equal(event.replyToEventId, work.assignmentEventId);
  assert.equal(event.target.eventId, work.sourceEventId);
  assert.equal(event.workResultReceipt?.workId, work.workId);
  assert.equal(event.workResultReceipt?.resultRevision, work.resultRevision);
  return event;
}
