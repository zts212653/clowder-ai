import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatId } from '@cat-cafe/shared';
import sharp from 'sharp';
import { scanAndPublishCodexImages } from '../../src/domains/cats/services/agents/providers/codex-image-scanner.js';
import { CliRawArchive } from '../../src/domains/cats/services/session/CliRawArchive.js';
import { mediaMessageFixture } from './media-message-fixture.js';

export async function mediaPublicationFixture(
  t: Parameters<typeof mediaMessageFixture>[0],
  multiTarget = false,
  options: {
    producerStatus?: 'succeeded' | 'running' | 'canceled';
    sharedProducer?: boolean;
    publicationLedger?: boolean;
  } = {},
) {
  const nativeRoot = await mkdtemp(join(tmpdir(), 'f309-publication-native-'));
  t.after(async () => {
    console.info(`retained owned native media evidence: ${nativeRoot}`);
  });
  let fixtureRef: Awaited<ReturnType<typeof mediaMessageFixture>> | undefined;
  const f = await mediaMessageFixture(
    t,
    'image/png',
    {
      get: (id) => fixtureRef?.dispatch.turns.get(id) ?? null,
      listBySource: (query) => fixtureRef?.dispatch.turns.listBySource(query) ?? [],
    },
    {
      authenticatedQueue: true,
      nativeImageArchiveDirectory: join(nativeRoot, 'raw'),
      publicationLedger: options.publicationLedger,
    },
  );
  fixtureRef = f;
  const human = f.send();
  if (multiTarget) {
    human.mentions.push(createCatId('sonnet'));
    human.whisperTo?.push(createCatId('sonnet'));
  }
  const blocked = options.sharedProducer
    ? f.dispatch.tracker.start(f.thread.id, 'codex-astra', 'operator', ['codex-astra'])
    : undefined;
  const request = await f.takeOver(human.id);
  const receipt = request.record.progress.review?.receiptRef;
  assert.ok(receipt);
  const key = `f309-return:${createHash('sha256').update(receipt).digest('hex')}`;
  const initial = f.messages.getByIdempotencyKey('operator', f.thread.id, key);
  assert.ok(initial);
  let secondRequest: typeof request | undefined;
  let secondCarrierId: string | undefined;
  if (options.sharedProducer) {
    const admitted = await f.lifecycle.admitOrResume({
      task: {
        threadId: f.thread.id,
        userId: 'operator',
        ownerCatId: createCatId('codex-astra'),
        createdBy: createCatId('codex-astra'),
        title: '第二份独立封面',
        why: '共同审阅另一份产物',
      },
      admission: {
        basis: 'explicit_entrustment',
        idempotencyKey: 'second-cover',
        sourceRefs: ['message:second-cover'],
        intendedOutcome: '审阅第二份封面',
      },
      closure: { condition: '完成第二份封面', expectedSignal: 'reviewed-publication' },
      time: { reviewBy: { value: Date.now() + 3600000, sourceRef: 'message:second-cover' } },
      artifactRefs: ['/uploads/review-input.png'],
    });
    assert.ok('subjectRef' in admitted && admitted.subjectRef);
    const taskId = admitted.subjectRef.replace(/^task:work:/, '');
    const review = await f.reviews.prepare({ ...f.prepare, taskId, operationId: 'prepare-second-cover' }, f.human);
    const second = f.send({
      ...f.attachment,
      id: 'second-image',
      source: {
        ...f.attachment.source,
        reviewId: review.review.reviewId,
        expectedReviewRevision: review.review.revision,
      },
      taskContext: {
        ...f.attachment.taskContext!,
        taskId,
        reviewId: review.review.reviewId,
        expectedTaskRevision: review.authority.taskRevision,
        expectedReviewRevision: review.review.revision,
      },
    });
    secondRequest = await f.takeOver(second.id);
    const secondReceipt = secondRequest.record.progress.review!.receiptRef;
    secondCarrierId = f.messages.getByIdempotencyKey(
      'operator',
      f.thread.id,
      `f309-return:${createHash('sha256').update(secondReceipt).digest('hex')}`,
    )!.id;
    const entry = f.queue.findEntryWithMessageId(f.thread.id, initial.id)!;
    // The deterministic provider consumes the second request too; real child creation and body exposure persist the causal binding.
    // Separate queued source admits its own child in the single Queue; no body-exposure shortcut.
    f.dispatch.tracker.complete(f.thread.id, 'codex-astra', blocked);
    await f.dispatch.processor.progressOwnedCarrier(entry, 'codex-astra');
  }
  const childId = await f.dispatch.waitForAwakening(initial.id);
  const child = f.dispatch.turns.get(childId);
  assert.ok(child);
  const sessionId = 'native-publication-session';
  const codexHome = join(nativeRoot, 'codex');
  const sourcePath = join(codexHome, 'generated_images', sessionId, 'exec-generated.png');
  await mkdir(join(codexHome, 'generated_images', sessionId), { recursive: true });
  const pixels = await sharp({ create: { width: 160, height: 100, channels: 3, background: 'green' } })
    .png()
    .toBuffer();
  await writeFile(sourcePath, pixels);
  const envelopes = [
    { direction: 'outbound', envelope: { id: 11, method: 'turn/start', params: { threadId: sessionId } } },
    { direction: 'inbound', envelope: { id: 11, result: { turn: { id: 'native-producing-turn' } } } },
    {
      direction: 'inbound',
      envelope: {
        method: 'item/completed',
        params: {
          threadId: sessionId,
          turnId: 'native-producing-turn',
          item: {
            type: 'imageGeneration',
            id: 'exec-generated',
            status: 'completed',
            failure: null,
            savedPath: sourcePath,
            result: pixels.toString('base64'),
          },
        },
      },
    },
  ];
  const archive = new CliRawArchive({ archiveDir: join(nativeRoot, 'raw') });
  for (const entry of envelopes) await archive.append(childId, { transport: 'codex_app_server', ...entry });
  const images = await scanAndPublishCodexImages({
    codexSessionId: sessionId,
    codexHome,
    uploadDir: f.root,
    nativeSource: { invocationId: childId, envelopes },
  });
  assert.equal(images.length, 1, 'real copied pixels and native generation must exist before recovery');
  const image = images[0]!;
  assert.deepEqual(await readFile(image.absPath), pixels);
  if (options.producerStatus !== 'running') {
    await f.dispatch.releaseProvider(childId, options.producerStatus ?? 'succeeded');
  }
  const projection = {
    invocationId: childId,
    parentInvocationId: child.parentInvocationId,
    executionKind: child.executionKind,
  };
  function publish(mode: 'append' | 'augment' | 'bare') {
    const message = f.messages.append({
      userId: 'operator',
      threadId: f.thread.id,
      from: { kind: 'agent', catId: createCatId('codex-astra') },
      mentions: [],
      timestamp: Date.now(),
      content: '原回合生成的图片',
      visibility: 'whisper',
      whisperTo: human.whisperTo ?? [],
      extra: { turnExecution: projection, ...(mode === 'append' ? { rich: { v: 1, blocks: [image.richBlock] } } : {}) },
    });
    if (mode === 'augment')
      f.messages.augmentStreamMetadata(message.id, {
        extra: { turnExecution: projection, rich: { v: 1, blocks: [image.richBlock] } },
      });
    return f.messages.getById(message.id)!;
  }
  const recover = () =>
    f.integration.recoverySpec.run.execute(null, 'content-modification-requests', {
      signal: new AbortController().signal,
      assignedCatId: null,
    });
  const carriers = () =>
    f.messages
      .getByThreadIncludingQueued(f.thread.id, 100, 'operator')
      .filter((message) => message.source?.meta?.kind === 'resume_media_publication');
  async function markOriginalHandled() {
    assert.equal(f.messages.getById(human.id)?.deliveryStatus, undefined);
    assert.equal(Object.hasOwn(human, 'queueCustody'), false);
    assert.equal(f.dispatch.turns.get(childId)?.status, 'succeeded');
  }
  return {
    ...f,
    nativeRoot,
    sourcePath,
    envelopes,
    humanMessage: human,
    request,
    secondRequest,
    child,
    image,
    publish,
    recover,
    carriers,
    markOriginalHandled,
  };
}
