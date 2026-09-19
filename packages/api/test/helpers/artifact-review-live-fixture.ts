import assert from 'node:assert/strict';
import { catRegistry, createCatId, type NeedsMeProducerId } from '@cat-cafe/shared';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../../src/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import { createArtifactReviewIntegration } from '../../src/domains/growing/artifact-review-composition.js';
import { EntrustedWorkLifecycleService } from '../../src/domains/growing/EntrustedWorkLifecycleService.js';
import { EntrustedWorkOwnerReadService } from '../../src/domains/growing/EntrustedWorkOwnerReadService.js';
import { F232PreparedArtifactReader } from '../../src/domains/growing/F232PreparedArtifactReader.js';
import { NeedsMeProducerCatalog } from '../../src/domains/growing/NeedsMeProducerCatalog.js';
import { ProjectContentOwnerService } from '../../src/domains/video-studio/content-owner/service.js';
import './setup-cat-registry.js';
import { createPersistedQueueFixture } from './persisted-queue-fixture.js';

export async function createLiveReviewFixture(
  root: string,
  mediaType: 'image/png' | 'video/mp4' = 'image/png',
  onEvent?: (userId: string, event: string, data: unknown) => void,
) {
  if (!catRegistry.has('codex-astra')) {
    const base = catRegistry.getOrThrow('codex').config;
    catRegistry.register('codex-astra', {
      ...base,
      id: createCatId('codex-astra'),
      displayName: '小星星·砚砚',
      defaultModel: 'gpt-6-astra',
    });
  }
  const tasks = new TaskStore(),
    threads = new ThreadStore(),
    messages = new MessageStore();
  const thread = threads.create('operator', '一起完成发布', root);
  const catId = createCatId('codex-astra');
  const owner = new ProjectContentOwnerService({ dataDir: root });
  const dispatch = createPersistedQueueFixture(messages);
  const { queue, starts } = dispatch;
  const events: { userId: string; event: string; data: unknown }[] = [];
  const emit = (userId: string, event: string, data: unknown) => {
    events.push({ userId, event, data });
    onEvent?.(userId, event, data);
  };
  const lifecycle = new EntrustedWorkLifecycleService(tasks, {
    onChanged: (ownerUserId) => emit(ownerUserId, 'entrusted_work_projection_invalidated', { ownerUserId }),
  });
  const extension = mediaType === 'image/png' ? 'png' : 'mp4';
  function publish(name = `review-input.${extension}`) {
    return messages.append({
      userId: 'operator',
      from: { kind: 'agent', catId },
      threadId: thread.id,
      mentions: [],
      timestamp: Date.now(),
      content: '准备好的发布产物',
      extra: {
        rich: {
          v: 1,
          blocks:
            mediaType === 'image/png'
              ? [{ kind: 'media_gallery', id: name, v: 1, items: [{ url: `/uploads/${name}`, alt: '可发布的封面' }] }]
              : [{ kind: 'file', id: name, v: 1, url: `/uploads/${name}`, fileName: name, mimeType: mediaType }],
        },
      },
    });
  }
  const publication = publish();
  const admitted = await lifecycle.admitOrResume({
    task: {
      threadId: thread.id,
      userId: 'operator',
      ownerCatId: catId,
      createdBy: catId,
      title: mediaType === 'image/png' ? '猫咖秋日封面' : '猫咖秋日短片',
      why: '完成发布前的共同审阅',
    },
    admission: {
      basis: 'explicit_entrustment',
      idempotencyKey: `review:${thread.id}`,
      sourceRefs: ['message:entrustment'],
      intendedOutcome: '审阅并发布这份产物',
    },
    closure: { condition: '完成审阅及产物发布', expectedSignal: 'reviewed-publication' },
    time: { reviewBy: { value: Date.now() + 3600000, sourceRef: 'message:entrustment' } },
    artifactRefs: [`/uploads/review-input.${extension}`],
  });
  assert.ok('subjectRef' in admitted && admitted.subjectRef);
  const taskId = admitted.subjectRef.replace(/^task:work:/, '');
  const publications = new F232PreparedArtifactReader({ messages });
  const integration = createArtifactReviewIntegration({
    dataDir: root,
    uploadDir: root,
    owner,
    publications,
    tasks,
    threads,
    messages,
    delivery: dispatch.delivery,
    emit,
    onError: (error) => events.push({ userId: 'operator', event: 'recovery_error', data: error }),
  });
  const passive = (producerId: NeedsMeProducerId) => ({
    producerId,
    async listCurrentReceipts() {
      return [];
    },
    async readCurrentReceipt() {
      return null;
    },
    async reEvaluate() {
      return { state: 'retired' as const, producerRevision: null };
    },
  });
  const catalog = new NeedsMeProducerCatalog([
    passive('f246.approval'),
    passive('f292.repair'),
    passive('f306.runtime_interaction'),
    integration.producer,
  ]);
  const ownerReads = new EntrustedWorkOwnerReadService({
    tasks,
    producerCatalog: catalog,
    artifactReader: integration.artifactReader,
  });
  return {
    ...integration,
    owner,
    tasks,
    threads,
    thread,
    taskId,
    messages,
    lifecycle,
    publication,
    publish,
    publications,
    catalog,
    ownerReads,
    starts,
    events,
    queue,
    dispatch,
    human: { userId: 'operator', actor: { kind: 'human' as const, actorId: 'operator' } },
    cat: { userId: 'operator', threadId: thread.id, actor: { kind: 'cat' as const, actorId: 'codex-astra' } },
    prepare: {
      taskId,
      expectedTaskRevision: 1,
      artifactRef: `/uploads/review-input.${extension}`,
      expectedArtifactRevision: String(publication.timestamp),
      operationId: 'prepare-live-review',
    },
  };
}
