import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { ContentModificationService } from '../src/domains/collaborative-content/modification/service.js';
import { EntrustedWorkLifecycleService } from '../src/domains/growing/EntrustedWorkLifecycleService.js';
import './helpers/setup-cat-registry.js';

test(
  'a live stalled preparation exhausts its attempt budget; recovery takes over and late work cannot overwrite it',
  { timeout: 4000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'f309-attempt-budget-'));
    const store = new ArtifactReviewStore(join(root, 'reviews.sqlite'));
    const tasks = new TaskStore();
    t.after(async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    const prepared = { kind: 'media' as const, contentRef: 'media-cover', ownerRevision: 1, ledgerRef: 'ledger-cover' };
    const stuck = Promise.withResolvers<typeof prepared>();
    let first = true;
    const errors: unknown[] = [];
    const service = new ContentModificationService({
      store,
      tasks,
      messages: new MessageStore(),
      lifecycle: new EntrustedWorkLifecycleService(tasks),
      leaseDurationMs: 1000,
      attemptBudgetMs: 150,
      authorizeTarget: async () => ({ targetName: '测试猫', threadTitle: '修改作品' }),
      dispatch: async () => {},
      onError: (error) => errors.push(error),
      content: {
        inspect: async () => ({ title: '作品', completionRule: 'published-result-ready' }),
        prepare: async () => {
          if (first) {
            first = false;
            return stuck.promise;
          }
          return prepared;
        },
        validatePrepared: async () => {},
        prepareCommit: async () => () => ({ reviewId: 'review-cover', round: 1, receiptRef: 'request-receipt' }),
      },
    });
    const result = await service.submit(
      {
        operationId: randomUUID(),
        targetCatId: 'codex',
        threadId: 'thread-cover',
        intent: { body: '请修改背景' },
        source: {
          kind: 'publication',
          contentRef: 'media-cover',
          ownerRevision: 1,
          ledgerRef: 'ledger-cover',
          expectedLedgerRevision: 1,
        },
      },
      { userId: 'operator', actor: { kind: 'human', actorId: 'operator' } },
    );
    assert.equal(result.record.issue?.code, 'attempt_timed_out');
    assert.equal(store.requests.pending().length, 1);
    await service.recover();
    const resumed = store.requests.get(result.record.requestId, 'operator');
    assert.ok(resumed?.progress.review, errors.map(String).join('\n'));
    assert.equal(tasks.listByThread('thread-cover').length, 1);
    stuck.resolve(prepared);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(store.requests.get(result.record.requestId, 'operator'), resumed, 'late worker has no live token');
    assert.equal(tasks.listByThread('thread-cover').length, 1);
  },
);
