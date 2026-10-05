import { join } from 'node:path';
import type { TaskSpec_P1 } from '../../../infrastructure/scheduler/types.js';
import type { InvocationQueue } from '../../cats/services/agents/invocation/InvocationQueue.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../cats/services/stores/ports/TaskStore.js';
import type { ITurnExecutionStore } from '../../cats/services/stores/ports/TurnExecutionStore.js';
import type { createArtifactReviewIntegration } from '../../growing/artifact-review-composition.js';
import { EntrustedWorkLifecycleService } from '../../growing/EntrustedWorkLifecycleService.js';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import type { WorkspaceContentSourceService } from '../../workspace/workspace-content-source.js';
import { WorkspaceWritebackService } from '../../workspace/writeback/service.js';
import type { WorkspaceContentReviewService } from '../workspace-review/service.js';
import { ModificationContentBinding } from './content-binding.js';
import { ContentModificationContextService } from './context-service.js';
import { ModificationRuntimeControlService } from './control/runtime-control-service.js';
import { ModificationFileLineage } from './file-lineage.js';
import { ModificationMediaBinding } from './media-binding.js';
import { ContentModificationResultService } from './result-service.js';
import { ContentModificationService } from './service.js';
import { ModificationSourceDiscussions } from './source-discussions.js';
import { ModificationTextBinding } from './text/text-binding.js';

export function createContentModificationIntegration(deps: {
  dataDir: string;
  source: WorkspaceContentSourceService;
  files: WorkspaceContentReviewService;
  artifacts: ReturnType<typeof createArtifactReviewIntegration>;
  tasks: ITaskStore;
  messages: IMessageStore;
  turnExecutions?: Pick<ITurnExecutionStore, 'get'>;
  queue?: Pick<InvocationQueue, 'getEntrySnapshot'>;
  changed: (userId: string) => void;
  sourceChanged?: (ownerUserId: string, threadId: string, messageId: string) => void;
  onError: (error: unknown) => void;
}) {
  const { store, media, reviews, ledgers, text, targets, dispatcher } = deps.artifacts;
  if (!ledgers || !text) throw new Error('F309 modification requires its F063 source composition');
  const lifecycle = new EntrustedWorkLifecycleService(deps.tasks, { onChanged: deps.changed });
  const fileLineage = new ModificationFileLineage({ store, media, messages: deps.messages });
  const content = new ModificationContentBinding({
    source: deps.source,
    media: new ModificationMediaBinding({ store, media, reviews, ledgers, files: deps.files, fileLineage }),
    text: new ModificationTextBinding({ store, source: deps.source, files: deps.files, access: media.access }),
  });
  const requests = new ContentModificationService({
    store,
    messages: deps.messages,
    tasks: deps.tasks,
    ...(deps.turnExecutions ? { turnExecutions: deps.turnExecutions } : {}),
    lifecycle,
    content,
    authorizeTarget: (payload, userId) => targets.authorize(payload, userId),
    dispatch: () => dispatcher.drain(),
    onError: deps.onError,
    ...(deps.sourceChanged ? { sourceChanged: deps.sourceChanged } : {}),
  });
  const writer = new WorkspaceWritebackService({
    source: deps.source,
    databasePath: join(deps.dataDir, 'workspace', 'writebacks.sqlite'),
    proofDirectory: join(deps.dataDir, 'workspace', 'writeback-proofs'),
  });
  const runtimeControls = new ModificationRuntimeControlService({
    journal: store.requests,
    requests,
    ...(deps.queue ? { queue: deps.queue } : {}),
    ...(deps.turnExecutions ? { turns: deps.turnExecutions } : {}),
  });
  const results = new ContentModificationResultService({ store, media, reviews, text, writer, fileLineage });
  const sourceDiscussions = new ModificationSourceDiscussions({
    store,
    files: deps.files,
    ledgers,
    reviews,
    access: media.access,
    messages: deps.messages,
  });
  const context = new ContentModificationContextService({
    store,
    media,
    reviews,
    requests,
    files: deps.files,
    ledgers,
    messages: deps.messages,
  });
  const recoverySpec: TaskSpec_P1 = {
    id: 'f309-modification-request-recovery',
    profile: 'poller',
    trigger: { type: 'interval', ms: 60_000 },
    admission: {
      async gate() {
        return { run: true, workItems: [{ signal: null, subjectKey: 'content-modification-requests' }] };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 120_000,
      async execute() {
        await requests.recover();
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: () => true,
    display: {
      label: '作品修改请求恢复',
      category: 'system',
      description: '续办已确认的请求及真实投递；不会自动接受或写回文件',
      subjectKind: 'none',
    },
  };
  const selection = async (
    input: {
      source: {
        kind: 'workspace';
        locator: { worktreeId: string; path: string };
        reviewId: string;
        expectedSourceRevision: string;
      };
      quote: string;
    },
    principal: MediaReviewPrincipal,
  ) => {
    await deps.files.describeSource({ principal, reviewId: input.source.reviewId, locator: input.source.locator });
    // The quote was selected on the rendered page; the owner maps it to the raw range behind it or refuses.
    const result = await deps.source.resolveRenderedTextSelection({
      principal,
      locator: input.source.locator,
      expectedRevision: input.source.expectedSourceRevision,
      quote: input.quote,
    });
    if (result.status !== 'attached') return { status: result.status };
    return {
      status: result.status,
      selection: { kind: 'text_quote' as const, baseRevision: result.sourceRevision, ...result.anchor },
    };
  };
  return {
    requests,
    results,
    targets,
    text,
    writer,
    recoverySpec,
    selection,
    context,
    sourceDiscussions,
    runtimeControls,
  };
}
