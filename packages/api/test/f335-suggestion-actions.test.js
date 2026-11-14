import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { applyWorkspaceReviewAction } from '../dist/domains/collaborative-content/workspace-review/workspace-review-actions.js';
import { workspaceAnnotationId } from '../dist/domains/collaborative-content/workspace-review/workspace-review-anchors.js';
import { createScheduledTaskSuggestionAction } from '../dist/domains/suggestions/actions/scheduled-task-action.js';
import { createVideoCommentsSuggestionAction } from '../dist/domains/suggestions/actions/video-comments-action.js';

const OWNER = 'user-operator';
const ctx = (overrides = {}) => ({
  userId: OWNER,
  threadId: 'thread_watch',
  catId: 'codex61-sol',
  suggestionId: 'sugg-1',
  attempt: 1,
  ...overrides,
});

describe('F335 「创建定时任务」 suggestion action', () => {
  let tasks;
  let registered;
  let action;
  const template = {
    label: '提醒',
    category: 'thread',
    description: '到点提醒',
    createSpec: (id) => ({ id }),
  };

  beforeEach(() => {
    tasks = new Map();
    registered = [];
    action = createScheduledTaskSuggestionAction({
      ownerUserId: OWNER,
      templateRegistry: { get: (id) => (id === 'reminder' ? template : null), list: () => [template] },
      dynamicTaskStore: { getById: (id) => tasks.get(id) ?? null },
      commit: {
        taskRunner: {
          registerDynamic: (_spec, id) => registered.push(id),
          unregister: (id) => registered.push(`-${id}`),
        },
        scheduleMutationProposalStore: {
          insertTaskWithAudit: (def) => tasks.set(def.id, structuredClone(def)),
          deleteTaskWithAudit: (id) => tasks.delete(id),
        },
      },
    });
  });

  const params = {
    templateId: 'reminder',
    trigger: { type: 'cron', expression: '0 9 * * 1' },
    params: { message: '看一眼本周作品' },
    label: '每周一 9:00 看作品',
  };

  it('checks the prepared task before the person ever sees the button', async () => {
    assert.equal((await action.prepare(ctx(), params)).ok, true);
    assert.equal((await action.prepare(ctx(), { ...params, templateId: 'nope' })).ok, false);
    assert.equal((await action.prepare(ctx(), { ...params, templateId: 'development-return' })).ok, false);
    assert.equal((await action.prepare(ctx({ userId: 'someone' }), params)).ok, false);
    assert.equal((await action.prepare(ctx(), { ...params, trigger: { type: 'once', delayMs: -1 } })).ok, false);
  });

  it('creates the task as the person, once per attempt, delivering to this conversation', async () => {
    const first = await action.apply(ctx(), params);
    const retried = await action.apply(ctx(), params);
    assert.equal(first.ok, true);
    assert.deepEqual(registered, ['dyn-sugg-sugg-1-1'], 'a retried attempt does not register twice');
    const task = tasks.get('dyn-sugg-sugg-1-1');
    assert.equal(task.createdBy, 'user');
    assert.equal(task.deliveryThreadId, 'thread_watch');
    assert.equal(task.params.triggerUserId, OWNER);
    assert.equal(first.value.receipt.text, '已创建定时任务「每周一 9:00 看作品」');
    assert.deepEqual(first.value.receipt.open, { kind: 'workspace-mode', mode: 'schedule' });
    assert.deepEqual(retried.value.appliedRef, first.value.appliedRef);
    assert.equal((await action.apply(ctx({ attempt: 2 }), params)).value.appliedRef.taskId, 'dyn-sugg-sugg-1-2');
  });

  it('reads 改了 from the task itself and undoes by deleting it', async () => {
    const { value } = await action.apply(ctx(), params);
    assert.equal(await action.inspect(ctx(), value.appliedRef), 'intact');
    tasks.get('dyn-sugg-sugg-1-1').enabled = false;
    assert.equal(await action.inspect(ctx(), value.appliedRef), 'edited');
    assert.equal((await action.undo(ctx(), value.appliedRef)).ok, true);
    assert.equal(tasks.has('dyn-sugg-sugg-1-1'), false);
    assert.equal(await action.inspect(ctx(), value.appliedRef), 'gone');
    assert.equal((await action.undo(ctx(), value.appliedRef)).ok, true, 'undoing a task already gone is a no-op');
  });

  it('lets a cat attach undo only to a task it registered in this conversation', async () => {
    tasks.set('dyn-1-a', { id: 'dyn-1-a', createdBy: 'codex61-sol', deliveryThreadId: 'thread_watch' });
    tasks.set('dyn-2-b', { id: 'dyn-2-b', createdBy: 'user', deliveryThreadId: 'thread_watch' });
    assert.equal(await action.verifyReceipt(ctx(), { taskId: 'dyn-1-a' }), true);
    assert.equal(await action.verifyReceipt(ctx(), { taskId: 'dyn-2-b' }), false);
    assert.equal(await action.verifyReceipt(ctx({ threadId: 'thread_other' }), { taskId: 'dyn-1-a' }), false);
  });
});

describe('F335 「添加视频批注」 suggestion action', () => {
  const media = {
    kind: 'video',
    width: 1920,
    height: 1080,
    codedWidth: 1920,
    codedHeight: 1080,
    rotation: 0,
    pixelAspectRatio: { numerator: 1, denominator: 1 },
    streamId: 'v0',
    streamIndex: 0,
    timebase: { numerator: 1, denominator: 1000 },
    startTick: 0,
    durationTicks: 60_000,
    containerStartSeconds: 0,
  };
  let review;
  let contexts;
  let changed;
  let action;
  /** Fault injection: the Nth write / the Nth withdraw (1-based) throws; null = never. */
  let failWriteAt;
  let failWithdrawAt;

  beforeEach(() => {
    review = { reviewId: 'review-1', revision: 3, annotations: [] };
    failWriteAt = null;
    failWithdrawAt = null;
    let writes = 0;
    let withdraws = 0;
    contexts = [];
    changed = [];
    const receipts = new Map();
    const reviews = {
      async resolvePublication() {
        return contexts;
      },
      async prepare() {
        return { review: structuredClone(review), canWrite: true };
      },
      async read() {
        return { review: structuredClone(review), canWrite: true };
      },
      async annotate(input) {
        if (receipts.has(input.operationId)) return { review: structuredClone(review), replayed: true };
        writes += 1;
        if (writes === failWriteAt) throw new Error('review store busy');
        assert.equal(input.expectedRevision, review.revision);
        review.revision += 1;
        review.annotations.push({
          id: workspaceAnnotationId(input.reviewId, input.operationId),
          body: input.body,
          anchor: input.target.anchor,
          replies: [],
        });
        receipts.set(input.operationId, true);
        return { review: structuredClone(review), replayed: false };
      },
      async act(input) {
        assert.equal(input.action.kind, 'withdraw_annotation');
        withdraws += 1;
        if (withdraws === failWithdrawAt) throw new Error('review store busy');
        review.revision += 1;
        review.annotations = review.annotations.filter((annotation) => annotation.id !== input.action.annotationId);
        return { review: structuredClone(review), replayed: false };
      },
    };
    const publications = {
      async read(contentRef, ownerRevision) {
        return { contentRef, ownerRevision, media, mediaType: 'video/mp4', blobDigest: `sha256:${'a'.repeat(64)}` };
      },
      async currentRevision() {
        return 4;
      },
    };
    action = createVideoCommentsSuggestionAction({
      reviews,
      publications,
      changed: (userId, reviewId) => changed.push([userId, reviewId]),
    });
  });

  const params = {
    contentRef: 'work:16fda226',
    ownerRevision: 4,
    title: '别每次都靠你想起来',
    comments: [
      { atSeconds: 12.5, text: '这里字幕压到了猫的脸' },
      { atSeconds: 40, endSeconds: 42, text: '这一段换场太快' },
    ],
  };

  it('refuses comments past the end and works whose comments live in a task review', async () => {
    assert.equal((await action.prepare(ctx(), params)).ok, true);
    const late = await action.prepare(ctx(), { ...params, comments: [{ atSeconds: 61, text: 'x' }] });
    assert.equal(late.ok, false);
    contexts = [{ reviewId: 'task-review' }];
    const tasked = await action.prepare(ctx(), params);
    assert.equal(tasked.ok, false);
    assert.match(tasked.error, /task review/);
  });

  it('writes each comment at its moment, as the person, and receipts with the work to open', async () => {
    const result = await action.apply(ctx(), params);
    assert.equal(result.ok, true);
    assert.deepEqual(
      review.annotations.map((annotation) => [annotation.anchor.startTick, annotation.anchor.endTick, annotation.body]),
      [
        [12_500, 12_501, '这里字幕压到了猫的脸'],
        [40_000, 42_000, '这一段换场太快'],
      ],
    );
    assert.equal(result.value.receipt.text, '已添加 2 条批注');
    assert.deepEqual(result.value.receipt.open, {
      kind: 'work',
      contentRef: 'work:16fda226',
      ownerRevision: 4,
      title: '别每次都靠你想起来',
    });
    assert.deepEqual(changed, [[OWNER, 'review-1']]);
    const again = await action.apply(ctx(), params);
    assert.equal(review.annotations.length, 2, 'a retried attempt replays instead of adding twice');
    assert.deepEqual(again.value.appliedRef, result.value.appliedRef);
  });

  it('takes the comments back on undo, and reads 改了 from what is left', async () => {
    const { value } = await action.apply(ctx(), params);
    assert.equal(await action.inspect(ctx(), value.appliedRef), 'intact');
    review.annotations = review.annotations.slice(1);
    assert.equal(await action.inspect(ctx(), value.appliedRef), 'edited');
    assert.equal((await action.undo(ctx(), value.appliedRef)).ok, true);
    assert.equal(review.annotations.length, 0);
    assert.equal(await action.inspect(ctx(), value.appliedRef), 'gone');
  });

  const three = {
    ...params,
    comments: [
      { atSeconds: 1, text: '一' },
      { atSeconds: 2, text: '二' },
      { atSeconds: 3, text: '三' },
    ],
  };

  it('takes back what it wrote when a later comment fails, and says so', async () => {
    failWriteAt = 3;
    const result = await action.apply(ctx(), three);
    assert.equal(result.ok, false);
    assert.equal(result.partial, undefined);
    assert.match(result.error, /第 3 条没加上，已加的 2 条已撤回/);
    assert.equal(review.annotations.length, 0, 'nothing is left behind');
  });

  it('when it cannot take them back either, returns exactly what stayed so the row can say it and undo it', async () => {
    failWriteAt = 3;
    failWithdrawAt = 2;
    const result = await action.apply(ctx(), three);
    assert.equal(result.ok, false);
    assert.match(result.error, /只加上了 1 条/);
    assert.equal(result.partial.receipt.text, '已添加 1 条批注（其余没加上）');
    assert.deepEqual(
      result.partial.appliedRef.annotationIds,
      review.annotations.map((annotation) => annotation.id),
    );
    assert.equal((await action.undo(ctx(), result.partial.appliedRef)).ok, true);
    assert.equal(review.annotations.length, 0);
  });

  it('an undo that stops part-way says how far it got, and the next undo finishes it', async () => {
    const { value } = await action.apply(ctx(), three);
    failWithdrawAt = 2;
    const first = await action.undo(ctx(), value.appliedRef);
    assert.equal(first.ok, false);
    assert.match(first.error, /撤回了 1 条/);
    assert.equal(review.annotations.length, 2);
    const second = await action.undo(ctx(), value.appliedRef);
    assert.equal(second.ok, true);
    assert.equal(review.annotations.length, 0);
  });

  it('does not undo once someone replied', async () => {
    const { value } = await action.apply(ctx(), params);
    review.annotations[0].replies = [{ id: 'r1' }];
    const undone = await action.undo(ctx(), value.appliedRef);
    assert.equal(undone.ok, false);
    assert.equal(review.annotations.length, 2, 'nothing is taken back halfway');
  });
});

describe('F335 withdraw_annotation (Works publication review)', () => {
  const human = (id) => ({ kind: 'human', actorId: id });
  const base = {
    review: {
      annotations: [
        { id: 'mine', author: human('operator'), replies: [], state: 'open' },
        { id: 'answered', author: human('operator'), replies: [{ id: 'r' }], state: 'open' },
        { id: 'theirs', author: human('someone'), replies: [], state: 'open' },
      ],
    },
    source: { kind: 'publication' },
    actor: human('operator'),
    now: '2026-11-02T18:00:00.000Z',
  };

  it('lets the author take back an annotation nobody replied to', () => {
    const next = applyWorkspaceReviewAction({ ...base, action: { kind: 'withdraw_annotation', annotationId: 'mine' } });
    assert.deepEqual(
      next.annotations.map((annotation) => annotation.id),
      ['answered', 'theirs'],
    );
  });

  it('refuses replied, foreign or unknown annotations', () => {
    for (const annotationId of ['answered', 'theirs', 'missing']) {
      assert.throws(() =>
        applyWorkspaceReviewAction({ ...base, action: { kind: 'withdraw_annotation', annotationId } }),
      );
    }
  });
});
