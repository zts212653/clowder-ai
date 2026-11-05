import { join } from 'node:path';
import { catRegistry, createCatId, type ProjectScreeningContextAttachment } from '@cat-cafe/shared';
import { loadCatConfig, toAllCatConfigs } from '../../src/config/cat-config-loader.js';
import { InMemoryTurnExecutionStore } from '../../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../../src/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import { ArtifactReviewStore } from '../../src/domains/collaborative-content/artifact-review/store.js';
import { resolveMessageTakeover } from '../../src/domains/collaborative-content/modification/message-takeover.js';
import { ProjectMessageTakeoverService } from '../../src/domains/collaborative-content/modification/project/service.js';
import { ContentModificationService } from '../../src/domains/collaborative-content/modification/service.js';
import { ModificationTargetService } from '../../src/domains/collaborative-content/modification/target-service.js';
import { ProjectMessageCatGrants } from '../../src/domains/collaborative-content/workspace-review/project-message/cat-grants.js';
import { VideoProjectMessageImporter } from '../../src/domains/collaborative-content/workspace-review/project-message/import.js';
import { WorkspaceContentReviewService } from '../../src/domains/collaborative-content/workspace-review/service.js';
import { EntrustedWorkLifecycleService } from '../../src/domains/growing/EntrustedWorkLifecycleService.js';
import { VideoProjectAccessError } from '../../src/domains/video-studio/project/access.js';
import { VideoProjectAssetIndex } from '../../src/domains/video-studio/project/asset-index.js';
import { VideoProjectService } from '../../src/domains/video-studio/project/service.js';
import { screeningFixture } from './video-project-screening.js';

for (const [id, config] of Object.entries(
  toAllCatConfigs(loadCatConfig(join(process.cwd(), '../../cat-template.json'))),
))
  if (!catRegistry.has(id)) catRegistry.register(id, config);

export async function projectTakeoverFixture() {
  if (!catRegistry.has('codex-astra'))
    catRegistry.register('codex-astra', {
      ...catRegistry.getOrThrow('codex').config,
      id: createCatId('codex-astra'),
      displayName: 'Astra',
    });
  const f = await screeningFixture();
  const screenings = f.make();
  const { screening } = await screenings.register(f.request);
  const store = new ArtifactReviewStore(join(f.root, 'artifact-reviews.sqlite'));
  const messages = new MessageStore();
  const tasks = new TaskStore();
  const threads = new ThreadStore();
  const thread = threads.create(f.principal.userId, 'Review', f.root);
  const turns = new InMemoryTurnExecutionStore();
  const lifecycle = new EntrustedWorkLifecycleService(tasks);
  let grants: ProjectMessageCatGrants | undefined;
  const projects = new VideoProjectService({
    owner: f.owner,
    ownerUserId: f.principal.userId,
    authorizeCat: async (input) => {
      if (!grants) throw new VideoProjectAccessError('Project source authority is not initialized');
      await grants.authorize(input);
    },
    assets: new VideoProjectAssetIndex({
      resolveRoot: async (rootId) => {
        if (rootId !== 'root') throw new Error('Unregistered root');
        return { root: f.root, canonicalWorktreeId: 'root' };
      },
    }),
  });
  const authority = {
    messages,
    authorizeSource: async (input: { principal: { userId: string }; threadId: string; messageId?: string }) => {
      const thread = threads.get(input.threadId);
      const source = input.messageId ? messages.getById(input.messageId) : undefined;
      if (
        !thread ||
        thread.createdBy !== input.principal.userId ||
        thread.deletedAt ||
        (input.messageId && (!source || source.userId !== input.principal.userId || source.threadId !== input.threadId))
      )
        throw Object.assign(new Error('Thread access denied'), { code: 'access_denied' });
    },
  };
  const importer = new VideoProjectMessageImporter({
    store: store.ledgers,
    projects,
    screenings,
    authority,
  });
  const attachment: ProjectScreeningContextAttachment = {
    v: 1,
    kind: 'project-screening',
    id: 'selected-opening',
    title: 'Opening',
    contentRef: screening.input.contentRef,
    screeningId: screening.id,
    input: screening.input,
    media: {
      contentRef: screening.media.contentRef,
      ownerRevision: screening.media.ownerRevision,
      blobDigest: screening.media.blobDigest,
    },
    selections: [
      {
        id: 'selection-1',
        mediaRange: {
          startPts: screening.media.media.startTick,
          endPts: screening.media.media.startTick + screening.media.media.durationTicks,
        },
        target: { kind: 'moment', tick: 0, endTick: 30, timebase: { numerator: 1, denominator: 30 } },
      },
    ],
  };
  const message = messages.append({
    userId: f.principal.userId,
    from: { kind: 'user', userId: f.principal.userId },
    threadId: thread.id,
    mentions: ['codex-astra'],
    content: 'Please fix the opening',
    timestamp: Date.now(),
    contentBlocks: [{ type: 'context_attachment', attachment }],
  });
  await importer.synchronize({ principal: f.principal, contentRef: f.request.contentRef, threadId: message.threadId });
  const principal = {
    userId: f.principal.userId,
    threadId: message.threadId,
    actor: { kind: 'cat' as const, actorId: 'codex-astra' },
    invocationId: 'child-1',
  };
  turns.createRunning({
    invocationId: principal.invocationId,
    parentInvocationId: 'parent-1',
    userId: principal.userId,
    catId: principal.actor.actorId,
    threadId: principal.threadId,
    startedAt: Date.now(),
    executionKind: 'ordinary',
    causal: { triggerMessageId: message.id },
  });
  const targets = new ModificationTargetService({ threads });
  const authorizeTarget = (payload: Parameters<typeof targets.authorize>[0], userId: string) =>
    targets.authorize(payload, userId);
  const errors: unknown[] = [];
  const makeProject = (canonical = store) =>
    new ProjectMessageTakeoverService({
      store: canonical,
      messages,
      tasks,
      turns,
      lifecycle,
      projects,
      importer,
      authority,
      authorizeTarget,
      onError: (error) => errors.push(error),
    });
  const project = makeProject();
  grants = new ProjectMessageCatGrants({ turns, authority, ledgers: store.ledgers, takeover: project });
  const resolver = (
    input: { sourceMessageId: string; operationId: string },
    caller = principal,
    existing?: Parameters<typeof resolveMessageTakeover>[3],
  ) =>
    resolveMessageTakeover(
      {
        messages,
        source: f.workspace,
        files: new WorkspaceContentReviewService({ source: f.workspace, store: store.ledgers }),
        requests: store.requests,
        tasks,
        project,
      },
      input,
      caller,
      existing,
    );
  const requests = new ContentModificationService({
    store,
    messages,
    tasks,
    lifecycle,
    turnExecutions: turns,
    authorizeTarget,
    project,
    resolveTakeover: (input, caller, existing) => resolver(input, caller as typeof principal, existing),
    content: {
      inspect: async () => {
        throw new Error('Legacy content must not consume project');
      },
      prepare: async () => {
        throw new Error('Legacy content must not consume project');
      },
      validatePrepared: async () => {
        throw new Error('Legacy content must not consume project');
      },
      prepareCommit: async () => {
        throw new Error('Legacy content must not consume project');
      },
    },
    dispatch: async () => {
      throw new Error('Project takeover does not resend the Human source');
    },
    onError: (error) => errors.push(error),
  });
  return {
    ...f,
    projects,
    screenings,
    store,
    messages,
    tasks,
    threads,
    turns,
    authority,
    importer,
    attachment,
    message,
    principal,
    resolver,
    project,
    requests,
    makeProject,
    errors,
    async cleanup() {
      store.close();
      await f.cleanup();
    },
  };
}
