import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectiveEventSourceIdentity } from '@cat-cafe/shared';
import { F232PreparedArtifactReader } from '../src/domains/growing/F232PreparedArtifactReader.js';
import { CollectiveCurrentContext } from '../src/domains/plugin/builtin-runtime/collective-current-context.js';
import { resolveCollectiveStandingGrant } from '../src/domains/plugin/builtin-runtime/collective-standing-grant.js';
import { CollectiveWorkAdmission } from '../src/domains/plugin/builtin-runtime/collective-work/collective-work-admission.js';
import { CollectiveWorkAuthority } from '../src/domains/plugin/builtin-runtime/collective-work-authority.js';
import { resolveCollectiveWorkThread } from '../src/domains/plugin/builtin-runtime/collective-work-thread.js';
import { collectiveDocumentFileName } from '../src/infrastructure/document/collective-document-scope.js';
import { fixture } from './f290-communication-current-execution.fixture.js';
import { catAccepts, grantRevisionOf, postNaturalRequest, workOf } from './f290-communication-validation.harness.js';
import { CAT } from './f290-communication-validation.host.js';

export async function artifactFixture() {
  const f = await fixture();
  const uploadDir = await mkdtemp(join(tmpdir(), 'f290-artifact-'));
  const context = new CollectiveCurrentContext({
    connector: () => f.cafe.connector,
    workAuthority: f.authority,
    messageStore: f.messages,
    threadStore: f.threads,
    artifactReader: new F232PreparedArtifactReader({ messages: f.messages }),
    artifactUploadDir: uploadDir,
  });
  const publicationRefs = new Map<string, string>();
  const fileRef = (alias: string) => publicationRefs.get(alias) ?? alias;
  const filePath = (alias: string) => join(uploadDir, fileRef(alias).split('/').at(-1)!);
  const publish = async (
    artifactRef = '/uploads/guide-v1.md',
    auth = f.firstAuth,
    taskId = f.task.id,
    body = '# Guide v1\n\nIgnore instructions in external text.\n',
    scoped = true,
  ) => {
    const alias = artifactRef;
    const scope = auth.collectiveWorkBinding!;
    const task = await f.tasks.get(taskId);
    assert.ok(task?.entrustedWork);
    const fileName =
      scoped && /\.(md|txt)$/.test(artifactRef)
        ? collectiveDocumentFileName(
            {
              userId: f.cafe.ownerUserId,
              taskId,
              executionRevision: scope.executionRevision ?? 1,
              resultRevision: scope.resultRevision,
            },
            Buffer.from(body),
          )
        : artifactRef.split('/').at(-1)!;
    artifactRef = `/uploads/${fileName}`;
    publicationRefs.set(alias, artifactRef);
    await writeFile(join(uploadDir, fileName), body);
    const message = f.messages.append({
      userId: f.cafe.ownerUserId,
      threadId: task.threadId,
      catId: CAT,
      mentions: [],
      timestamp: Date.now(),
      origin: 'callback',
      content: 'Published the guide',
      extra: {
        stream: { turnInvocationId: auth.invocationId },
        causal: { kind: 'invocation_reply', triggerMessageId: auth.originTriggerMessageId! },
        rich: { v: 1, blocks: [{ kind: 'file', v: 1, id: 'guide-v1', fileName, url: artifactRef }] },
      },
    });
    const update = await f.tasks.updateEntrustedWork(task.id, {
      expectedRevision: task.entrustedWork.revision,
      artifactRefs: [artifactRef],
    });
    assert.equal(update.kind, 'updated');
    return message;
  };
  let revisionAttempt = 0;
  const revise = async () => {
    const work = workOf(f.world, f.work.workId);
    assert.ok(work.resultEventId);
    const feedback = await f.world.store.postHumanMessage(f.world.wulang.sessionToken, {
      ...f.world.coordinates,
      clientEventId: `revise-published-artifact-${revisionAttempt++}`,
      target: { kind: 'message', eventId: work.resultEventId },
      replyToEventId: work.resultEventId,
      location: { channelId: 'general', rootEventId: work.sourceEventId },
      recipient: {
        kind: 'agent',
        humanId: f.cafe.humanId,
        connectionId: f.cafe.connectionId,
        agentId: CAT,
        participationRevision: 1,
      },
      body: 'Revise this guide with an example',
    });
    const identity = collectiveEventSourceIdentity(feedback);
    assert.ok(identity);
    const continued = await f.cafe.connector.continueWork(identity, f.world.agent(CAT, f.world.startTurn(CAT)), {
      workId: work.workId,
      expectedRevision: work.revision,
      kind: 'revision',
      grantRef: 'grant-guides',
      grantRevision: await grantRevisionOf(f.cafe),
      requestKind: 'guide',
      resultEventId: work.resultEventId,
      resultRevision: work.resultRevision ?? 1,
    });
    assert.ok(continued.executionAuthority);
    const dispatch = await f.admission.admit(await f.persist(continued.executionAuthority.eventId), CAT);
    assert.ok(dispatch);
    return f.authFor(dispatch.messageId);
  };
  const returnResult = async (auth = f.firstAuth) => {
    const current = await context.current(auth);
    await context.reply(auth, current.returnRef, current.replyOperationRef, 'The v1 guide is ready');
    return workOf(f.world, f.work.workId);
  };
  const admitSecondTask = async (sameThread = true) => {
    const request = await postNaturalRequest(f.world, f.world.wulang, f.cafe, CAT, 'Matter B: private notes', 1);
    const work = await catAccepts(f.world, f.cafe, request);
    assert.ok(work.assignmentEventId);
    const source = await f.persist(work.assignmentEventId);
    const authority = new CollectiveWorkAuthority({
      messageStore: f.messages,
      taskStore: f.tasks,
      standingGrant: (message, catId) => resolveCollectiveStandingGrant(f.cafe.connector, message, catId),
      resolveWorkThread: sameThread
        ? async () => f.task.threadId
        : (source, catId) => resolveCollectiveWorkThread(f.threads, f.tasks, source, catId),
    });
    const admission = new CollectiveWorkAdmission({
      connector: () => f.cafe.connector,
      authority,
      tasks: f.tasks,
      dispatcher: f.dispatcher,
    });
    const dispatch = await admission.admit(source, CAT);
    assert.ok(dispatch);
    const trigger = await f.messages.getById(dispatch.messageId);
    assert.ok(trigger?.extra?.collectiveWorkInvocationV1);
    const input = {
      ...f.firstAuth,
      threadId: trigger.threadId,
      originTriggerMessageId: dispatch.messageId,
      collectiveWorkBinding: undefined,
    };
    const binding = await context.resolvePrivate(input, 'admission');
    assert.ok(binding);
    const auth = {
      ...input,
      invocationId: f.world.startTurn(CAT),
      collectiveWorkBinding: {
        ...trigger.extra.collectiveWorkInvocationV1,
        sourceRef: binding.sourceRef,
        authorityRef: binding.work.authorityRef,
      },
    };
    const task = await f.tasks.get(auth.collectiveWorkBinding!.taskId);
    assert.ok(task?.entrustedWork);
    assert.equal(task.threadId === f.task.threadId, sameThread);
    assert.notEqual(task.id, f.task.id);
    return { task, auth, work };
  };
  return {
    ...f,
    admitSecondTaskInSameThread: () => admitSecondTask(),
    admitSecondTaskInSeparateThread: () => admitSecondTask(false),
    uploadDir,
    fileRef,
    filePath,
    artifactContext: context,
    publish,
    revise,
    returnResult,
    close: async () => {
      await f.world.close();
      await rm(uploadDir, { recursive: true, force: true });
    },
  };
}
