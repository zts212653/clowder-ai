import { createCatId, type TaskItem } from '@cat-cafe/shared';
import type { StoredMessage } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import type { Thread } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import { F232PreparedArtifactReader } from '../../src/domains/growing/F232PreparedArtifactReader.js';
import {
  type MediaReviewPrincipal,
  PublishedMediaAccess,
} from '../../src/domains/video-studio/content-owner/published-media-access.js';
import { PublishedMediaService } from '../../src/domains/video-studio/content-owner/published-media-service.js';
import { PublishedMediaSource } from '../../src/domains/video-studio/content-owner/published-media-source.js';
import { ProjectContentOwnerService } from '../../src/domains/video-studio/content-owner/service.js';

export const reviewHuman: MediaReviewPrincipal = { userId: 'operator', actor: { kind: 'human', actorId: 'operator' } };
export const reviewCat: MediaReviewPrincipal = {
  userId: 'operator',
  threadId: 'thread-cover',
  actor: { kind: 'cat', actorId: 'codex-astra' },
};

export function createReviewFixture(dataDir: string, uploadDir: string) {
  const task: { current: TaskItem | null } = {
    current: {
      id: 'task-cover',
      kind: 'work',
      threadId: 'thread-cover',
      subjectKey: 'entrusted:cover',
      title: '猫咖活动封面',
      userId: 'operator',
      ownerCatId: createCatId('codex-astra'),
      status: 'doing',
      why: '准备可发布的封面',
      createdBy: 'user',
      createdAt: 1000,
      updatedAt: 1000,
      entrustedWork: {
        revision: 1,
        admission: {
          basis: 'explicit_entrustment',
          sourceRefs: ['message:request'],
          idempotencyKey: 'entrusted:cover',
          receiptRef: 'task:receipt:cover',
          admittedAt: 1000,
        },
        intendedOutcome: '完成封面审阅并发布',
        time: {},
        artifactRefs: ['/uploads/cover.png'],
        closure: {
          condition: '封面审阅和发布均完成',
          expectedSignal: 'published-cover',
          state: 'open',
          evidenceRefs: [],
        },
      },
    },
  };
  const thread: { current: Thread | null } = {
    current: {
      id: 'thread-cover',
      title: '活动发布',
      projectPath: dataDir,
      createdBy: 'operator',
      participants: [createCatId('codex-astra')],
      createdAt: 1000,
      lastActiveAt: 1000,
    },
  };
  const messages = new Map<string, StoredMessage>();
  function publish(url = '/uploads/cover.png', mediaType = 'image/png') {
    const id = `media-${messages.size + 1}`;
    const message: StoredMessage = {
      id,
      threadId: 'thread-cover',
      userId: 'operator',
      catId: createCatId('codex-astra'),
      content: '产物已准备好',
      timestamp: 1000 + messages.size,
      mentions: [],
      extra: {
        rich: {
          v: 1,
          blocks:
            mediaType === 'image/png'
              ? [{ kind: 'media_gallery', id: 'image', v: 1, items: [{ url, alt: '活动封面' }] }]
              : [{ kind: 'file', id: 'video', v: 1, url, fileName: '活动短片.mp4', mimeType: mediaType }],
        },
      },
    };
    messages.set(id, message);
    return message;
  }
  const publication = publish();
  const messageStore = {
    getById: (id: string) => messages.get(id) ?? null,
    getByThread: () => [...messages.values()],
    getByThreadBefore: () => [],
  };
  const threadStore = {
    get: () => thread.current,
    list: () => (thread.current ? [thread.current] : []),
    getThreadMemory: () => null,
  };
  const taskStore = {
    get: (id: string) => (task.current?.id === id ? task.current : null),
    listByThread: () => (task.current ? [task.current] : []),
  };
  const artifactDeps = { messages: messageStore, tasks: taskStore, threads: threadStore };
  const artifacts = new F232PreparedArtifactReader(artifactDeps);
  const access = new PublishedMediaAccess({ tasks: taskStore, threads: threadStore });
  const sources = new PublishedMediaSource({ artifacts, messages: messageStore, uploadDir });
  const owner = new ProjectContentOwnerService({ dataDir });
  const media = new PublishedMediaService({ access, sources, owner });
  const prepare = {
    taskId: 'task-cover',
    expectedTaskRevision: 1,
    artifactRef: '/uploads/cover.png',
    expectedArtifactRevision: String(publication.timestamp),
    operationId: 'prepare-cover',
    principal: reviewHuman,
  };
  return {
    task,
    thread,
    taskStore,
    threadStore,
    messages,
    messageStore,
    publication,
    publish,
    artifacts,
    access,
    sources,
    owner,
    media,
    prepare,
  };
}
