import { describe, expect, it } from 'vitest';
import {
  describeModificationProgress,
  describeModificationReadFailure,
  type ModificationProgressInput,
} from '../modification-progress-copy';

type ExecutionState = NonNullable<ModificationProgressInput['view']['execution']>['state'];
type Stage = ModificationProgressInput['view']['stage'];

function input(
  patch: {
    stage?: Stage;
    execution?: ExecutionState;
    cancelled?: boolean;
    issue?: boolean;
    candidates?: number;
  } = {},
  extra: Partial<Pick<ModificationProgressInput, 'targetName' | 'contentTitle' | 'placeCount'>> = {},
): ModificationProgressInput {
  return {
    targetName: '烁烁',
    ...extra,
    view: {
      stage: patch.stage ?? 'queued',
      candidates: Array.from({ length: patch.candidates ?? 0 }, (_, index) => ({
        kind: 'media' as const,
        candidateRef: `candidate-${index}`,
        asset: {} as never,
        authorCatId: 'codex',
        responses: [],
      })),
      execution: patch.execution
        ? {
            state: patch.execution,
            messageId: 'carrier',
            targetCatId: 'codex',
            observedAt: 1,
            evidenceRef: 'evidence',
          }
        : undefined,
      record: {
        control: patch.cancelled
          ? {
              state: 'cancelled' as const,
              actorId: 'operator',
              cancelledAt: 1,
              receiptRef: 'receipt',
              taskResolution: 'preserved' as const,
            }
          : undefined,
        issue: patch.issue ? { code: 'attempt_timed_out', retryable: true } : undefined,
      },
    },
  };
}

describe('describeModificationProgress — accepted Studio state board', () => {
  it('shows a running change with the artwork, the number of places and an inline cancel', () => {
    for (const state of ['starting', 'running'] as const) {
      const copy = describeModificationProgress(
        input({ execution: state }, { contentTitle: '窄屏设计稿', placeCount: 2 }),
      );
      expect(copy).toMatchObject({
        key: 'working',
        indicator: 'spinner',
        title: '烁烁修改中 · 窄屏设计稿 2\u00A0处',
        chip: '烁烁修改中 · 2\u00A0处',
        action: { kind: 'cancel-request', label: '取消修改', compactLabel: '取消' },
      });
    }
  });

  it('degrades the running title gracefully when the artwork or the place count is unknown', () => {
    expect(describeModificationProgress(input({ execution: 'running' }, { contentTitle: '窄屏设计稿' }))).toMatchObject(
      { title: '烁烁修改中 · 窄屏设计稿', chip: '烁烁修改中' },
    );
    expect(describeModificationProgress(input({ execution: 'running' }, { placeCount: 1 }))).toMatchObject({
      title: '烁烁修改中 · 1\u00A0处',
      chip: '烁烁修改中 · 1\u00A0处',
    });
    expect(describeModificationProgress(input({ execution: 'running' }))).toMatchObject({
      title: '烁烁修改中',
      chip: '烁烁修改中',
    });
    // A zero or missing count is never rendered as "0 处".
    expect(describeModificationProgress(input({ execution: 'running' }, { placeCount: 0 }))?.title).toBe('烁烁修改中');
  });

  it('says queued work has not started and offers the plain cancel', () => {
    for (const patch of [{ execution: 'queued' as const }, { stage: 'queued' as const }]) {
      expect(describeModificationProgress(input(patch))).toMatchObject({
        key: 'queued',
        indicator: 'neutral',
        title: '已排队',
        detail: '烁烁尚未开始处理。',
        action: { kind: 'cancel-request', label: '取消修改', compactLabel: '取消修改' },
      });
    }
  });

  it('does not call a finished run with no new version a success', () => {
    expect(describeModificationProgress(input({ execution: 'finished' }))).toMatchObject({
      key: 'finished_without_version',
      indicator: 'neutral',
      title: '执行已结束，尚无新版本',
      detail: '暂无可审阅的版本。',
    });
    expect(describeModificationProgress(input({ execution: 'finished' }))?.action).toBeUndefined();
  });

  it('hides the progress line once a new version exists, because the version record takes over', () => {
    expect(describeModificationProgress(input({ execution: 'finished', candidates: 1 }))).toBeNull();
  });

  it('keeps showing progress when an earlier round already left a candidate but a new run is active', () => {
    expect(describeModificationProgress(input({ execution: 'running', candidates: 1 }))?.key).toBe('working');
  });

  it('reports failed and interrupted runs as incomplete and points at the execution conversation', () => {
    expect(describeModificationProgress(input({ execution: 'interrupted' }))).toMatchObject({
      key: 'incomplete',
      indicator: 'danger',
      title: '修改未完成',
      detail: '执行已中断，修改说明已保留。',
      action: { kind: 'open-execution', label: '打开执行对话' },
    });
    expect(describeModificationProgress(input({ execution: 'failed' }))).toMatchObject({
      key: 'incomplete',
      detail: '执行失败，修改说明已保留。',
      action: { kind: 'open-execution' },
    });
  });

  it('refuses to guess when the execution status cannot be verified', () => {
    expect(describeModificationProgress(input({ execution: 'unknown' }))).toMatchObject({
      key: 'unavailable',
      indicator: 'attention',
      title: '无法获取状态',
      detail: '暂时无法确认修改是否仍在进行。',
      action: { kind: 'reload', label: '重新加载' },
    });
  });

  it('keeps cancelling the request separate from stopping a run that is still going', () => {
    for (const execution of ['running', 'starting', 'withdrawn_running'] as const) {
      expect(describeModificationProgress(input({ cancelled: true, execution }))).toMatchObject({
        key: 'cancelled_still_running',
        indicator: 'attention',
        title: '修改已取消，执行仍在进行',
        detail: '取消修改不会停止本轮执行。',
        action: { kind: 'stop-run', label: '停止执行…' },
      });
    }
    // A withdrawn carrier with a live run is a withdrawal, not an owner's cancellation record: say what happened.
    expect(describeModificationProgress(input({ execution: 'withdrawn_running' }))).toMatchObject({
      key: 'withdrawn_still_running',
      indicator: 'attention',
      title: '修改请求已撤回，执行仍在进行',
      detail: '撤回不会停止本轮执行。',
      action: { kind: 'stop-run', label: '停止执行…' },
    });
  });

  it('shows a cancelled request without a stop action once nothing is running', () => {
    for (const patch of [
      { cancelled: true, execution: 'finished' as const },
      { cancelled: true, execution: 'cancelled' as const },
      { cancelled: true, stage: 'cancelled' as const },
    ]) {
      const copy = describeModificationProgress(input(patch));
      expect(copy).toMatchObject({ key: 'cancelled', indicator: 'neutral', title: '修改已取消' });
      expect(copy?.action).toBeUndefined();
    }
  });

  it('does not turn a stopped or withdrawn execution into a cancelled request', () => {
    // The server reports execution "cancelled" when the invocation was stopped, or when the carrier was
    // withdrawn before any run. Neither is the owner's cancellation record, and the request is still valid.
    for (const stage of ['queued', 'pending_delivery'] as const) {
      const copy = describeModificationProgress(input({ stage, execution: 'cancelled' }));
      expect(copy).toMatchObject({
        key: 'incomplete',
        indicator: 'attention',
        title: '修改未完成',
        detail: '执行已取消，修改说明已保留。',
        action: { kind: 'open-execution', label: '打开执行对话' },
      });
      expect(`${copy?.title}${copy?.detail}`).not.toContain('修改已取消');
    }
  });

  it('describes a cancelled delivery as a delivery, because without an owner cancellation the stage is the delivery intent', () => {
    // Without `record.control` the server's stage comes from the return/delivery intent (service.ts project()),
    // so "cancelled" there is not the owner's request cancellation.
    const copy = describeModificationProgress(input({ stage: 'cancelled' }));
    expect(copy).toMatchObject({
      key: 'incomplete',
      indicator: 'attention',
      title: '修改未完成',
      detail: '投递已取消，修改说明已保留。',
    });
    expect(copy?.action).toBeUndefined();
    // With the owner's record the same stage is a real cancellation.
    expect(describeModificationProgress(input({ stage: 'cancelled', cancelled: true }))?.key).toBe('cancelled');
  });

  it('does not claim a cancelled request has stopped when the execution cannot be verified', () => {
    expect(describeModificationProgress(input({ cancelled: true, execution: 'unknown' }))).toMatchObject({
      key: 'cancelled_run_unknown',
      indicator: 'attention',
      title: '修改已取消',
      detail: '暂时无法确认本轮执行是否已停止。',
      action: { kind: 'reload', label: '重新加载' },
    });
  });

  it('describes the stages before the cat is reached without internal vocabulary', () => {
    for (const stage of ['saving_source', 'preparing_content', 'admitting_task', 'binding_request'] as const) {
      expect(describeModificationProgress(input({ stage }))).toMatchObject({
        key: 'submitting',
        indicator: 'spinner',
        title: '正在提交修改',
        action: { kind: 'cancel-request', label: '取消修改' },
      });
    }
    expect(describeModificationProgress(input({ stage: 'pending_delivery' }))).toMatchObject({
      key: 'delivering',
      indicator: 'neutral',
      title: '等待送达',
      detail: '修改说明已保存，尚未交给烁烁。',
    });
    expect(describeModificationProgress(input({ stage: 'retired' }))).toMatchObject({
      key: 'incomplete',
      title: '修改未完成',
      detail: '投递已停止，修改说明已保留。',
    });
    expect(describeModificationProgress(input({ stage: 'retired' }))?.action).toBeUndefined();
  });

  it('reports a request that never reached a cat as incomplete rather than silently queued', () => {
    expect(describeModificationProgress(input({ stage: 'binding_request', issue: true }))).toMatchObject({
      key: 'incomplete',
      title: '修改未完成',
    });
  });

  it('lets a real execution outrank a stale submission issue', () => {
    expect(describeModificationProgress(input({ stage: 'queued', execution: 'running', issue: true }))?.key).toBe(
      'working',
    );
  });

  it('never claims completion, success or a write-back in any state', () => {
    const states: ModificationProgressInput[] = [];
    for (const stage of [
      'saving_source',
      'preparing_content',
      'admitting_task',
      'binding_request',
      'pending_delivery',
      'queued',
      'cancelled',
      'retired',
    ] as const)
      states.push(input({ stage }));
    for (const execution of [
      'queued',
      'starting',
      'running',
      'finished',
      'failed',
      'cancelled',
      'interrupted',
      'withdrawn_running',
      'unknown',
    ] as const) {
      states.push(input({ execution }), input({ execution, cancelled: true }));
    }
    for (const state of states) {
      const copy = describeModificationProgress(state);
      if (!copy) continue;
      expect(`${copy.title}${copy.detail ?? ''}`).not.toMatch(/已完成|成功|已写回|已采用|通过/);
      // Every state carries a human label; nothing leaks a raw status code.
      expect(copy.title).not.toMatch(/[a-z_]{4,}/);
    }
  });
});

describe('describeModificationReadFailure', () => {
  it('admits the state is unknown instead of repeating the last guess', () => {
    expect(describeModificationReadFailure()).toMatchObject({
      key: 'unavailable',
      indicator: 'attention',
      title: '无法获取状态',
      detail: '暂时无法确认修改是否仍在进行。',
      action: { kind: 'reload', label: '重新加载' },
    });
  });
});
