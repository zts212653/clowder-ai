import type { TaskSpec_P1 } from '../../infrastructure/scheduler/types.js';
import type { ArtifactReviewService } from '../collaborative-content/artifact-review/service.js';
import type { ArtifactReviewStore } from '../collaborative-content/artifact-review/store.js';
import type { ArtifactReviewReturnDispatcher } from './ArtifactReviewReturnDispatcher.js';
import type { F309ContentReviewProducerAdapter } from './F309ContentReviewProducerAdapter.js';

export function createArtifactReviewRecoveryTaskSpec(deps: {
  reviews: ArtifactReviewService;
  store: ArtifactReviewStore;
  producer: F309ContentReviewProducerAdapter;
  dispatcher: ArtifactReviewReturnDispatcher;
  onChanged: (ownerUserId: string, reviewId: string) => void;
  onError: (error: unknown) => void;
}): TaskSpec_P1 {
  return {
    id: 'f309-artifact-review-recovery',
    profile: 'poller',
    trigger: { type: 'interval', ms: 60_000 },
    admission: {
      async gate() {
        return { run: true, workItems: [{ signal: null, subjectKey: 'artifact-review-recovery' }] };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 120_000,
      async execute() {
        for (const id of deps.store.listReviewIds()) {
          let review = deps.store.get(id);
          if (!review) continue;
          try {
            if (deps.store.pendingVersion(id)) {
              const before = review.revision;
              const ownerUserId = review.task.ownerUserId;
              try {
                await deps.reviews.read(id, {
                  userId: ownerUserId,
                  actor: { kind: 'human', actorId: ownerUserId },
                });
              } finally {
                review = deps.store.get(id);
                if (review && review.revision !== before) deps.onChanged(ownerUserId, id);
              }
              if (!review) continue;
            }
            if (review.rounds.at(-1)?.state === 'awaiting_human')
              await deps.producer.reEvaluate({
                ownerUserId: review.task.ownerUserId,
                producerSubjectRef: id,
                expectedProducerRevision: review.revision,
                taskRef: {
                  subjectRef: `task:work:${review.task.taskId}`,
                  observedRevision: review.task.observedRevision,
                },
                reEvaluateActionRef: `content-review:${id}#reevaluate`,
              });
          } catch (error) {
            deps.onError(error);
          }
        }
        try {
          await deps.dispatcher.drain();
        } catch (error) {
          deps.onError(error);
        }
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: () => true,
    display: {
      label: '产物审阅恢复',
      category: 'system',
      description: '恢复已接受的媒体写入及原任务回流，重读过期的审阅判断请求',
      subjectKind: 'none',
    },
  };
}
