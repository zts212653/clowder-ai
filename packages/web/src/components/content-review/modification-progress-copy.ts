import type { ContentModificationDetailView } from '@cat-cafe/shared';

/**
 * The one place where a content-modification request's real state becomes interface wording.
 * Wording follows the accepted Studio state board (north-star §1.3 S3/S7); states the board does not
 * draw (the submission stages before a cat is reached) use the same noun/verb register and are
 * flagged where they are defined. Nothing here may read as completion: a finished run without a new
 * version, a cancelled request with a run still going, and an unverifiable state each say exactly that.
 */
export type ModificationProgressKey =
  | 'accepted'
  | 'submitting'
  | 'delivering'
  | 'queued'
  | 'working'
  | 'finished_without_version'
  | 'incomplete'
  | 'unavailable'
  | 'cancelled'
  | 'cancelled_still_running'
  | 'cancelled_run_unknown'
  | 'withdrawn_still_running';

/** Status dots carry state only (DESIGN: colour is never text colour); `spinner` means work in progress. */
export type ModificationProgressIndicator = 'spinner' | 'neutral' | 'attention' | 'danger' | 'success';

export type ModificationProgressActionKind =
  | 'cancel-request'
  | 'open-execution'
  | 'reload'
  | 'stop-run'
  | 'open-comparison'
  | 'open-file';

export interface ModificationProgressAction {
  kind: ModificationProgressActionKind;
  /** Full, unambiguous name; also the accessible name of the control. */
  label: string;
  /** Short visible text for the compact one-line form in chat. */
  compactLabel: string;
}

export interface ModificationProgressCopy {
  key: ModificationProgressKey;
  indicator: ModificationProgressIndicator;
  title: string;
  detail?: string;
  action?: ModificationProgressAction;
  /** Top-bar chip text; only present while a cat is actively changing the work. */
  chip?: string;
}

/**
 * What the one-line chat presentation needs. Progress lines and Host receipts both render through it, so the
 * `key` is only a label for tests and `data-state`, not a union the row has to know.
 */
export type ModificationLineCopy = Omit<ModificationProgressCopy, 'key'> & { key: string };

export interface ModificationProgressInput {
  view: Pick<ContentModificationDetailView, 'stage' | 'execution' | 'candidates'> & {
    record: Pick<ContentModificationDetailView['record'], 'control' | 'issue'>;
  };
  targetName: string;
  contentTitle?: string;
  /** How many places on the work the request covers; absent or zero is never printed. */
  placeCount?: number;
}

const action = (
  kind: ModificationProgressActionKind,
  label: string,
  compactLabel = label,
): ModificationProgressAction => ({
  kind,
  label,
  compactLabel,
});

const cancelRequest = () => action('cancel-request', '取消修改');

const unavailable = (): ModificationProgressCopy => ({
  key: 'unavailable',
  indicator: 'attention',
  title: '无法获取状态',
  detail: '暂时无法确认修改是否仍在进行。',
  action: action('reload', '重新加载'),
});

/** A failed read says "unknown"; it never repeats the last known state as if it were current. */
export function describeModificationReadFailure(): ModificationProgressCopy {
  return unavailable();
}

/** A count and its unit never part at a line break: a narrow bubble must not leave a lone "处" on the next line. */
function placesLabel(count: number | undefined): string {
  return count && count > 0 ? `${count} 处` : '';
}

function stillRunning(state: string | undefined): boolean {
  return state === 'running' || state === 'starting' || state === 'withdrawn_running';
}

const cancelled = (): ModificationProgressCopy => ({
  key: 'cancelled',
  indicator: 'neutral',
  title: '修改已取消',
  detail: '修改说明和已有候选已保留。',
});

const incomplete = (
  detail: string,
  withExecutionLink = false,
  indicator: 'danger' | 'attention' = 'danger',
): ModificationProgressCopy => ({
  key: 'incomplete',
  indicator,
  title: '修改未完成',
  detail,
  ...(withExecutionLink ? { action: action('open-execution', '打开执行对话') } : {}),
});

function queued(targetName: string): ModificationProgressCopy {
  return {
    key: 'queued',
    indicator: 'neutral',
    title: '已排队',
    detail: `${targetName}尚未开始处理。`,
    action: cancelRequest(),
  };
}

/**
 * Cancelling the request and stopping the run are two different things; the words keep them apart. This only
 * runs for a real cancellation record: an execution that was merely stopped is not a cancelled request.
 */
function describeCancellation(execution: string | undefined): ModificationProgressCopy {
  if (execution === 'unknown') {
    return {
      key: 'cancelled_run_unknown',
      indicator: 'attention',
      title: '修改已取消',
      detail: '暂时无法确认本轮执行是否已停止。',
      action: action('reload', '重新加载'),
    };
  }
  return stillRunning(execution)
    ? {
        key: 'cancelled_still_running',
        indicator: 'attention',
        title: '修改已取消，执行仍在进行',
        detail: '取消修改不会停止本轮执行。',
        action: action('stop-run', '停止执行…'),
      }
    : cancelled();
}

/** The carrier was withdrawn while a run continues: a withdrawal, which is not the owner's cancellation record. */
function describeWithdrawal(): ModificationProgressCopy {
  return {
    key: 'withdrawn_still_running',
    indicator: 'attention',
    title: '修改请求已撤回，执行仍在进行',
    detail: '撤回不会停止本轮执行。',
    action: action('stop-run', '停止执行…'),
  };
}

function describeWorking(input: ModificationProgressInput): ModificationProgressCopy {
  const places = placesLabel(input.placeCount);
  const subject = [input.contentTitle, places].filter(Boolean).join(' ');
  return {
    key: 'working',
    indicator: 'spinner',
    title: subject ? `${input.targetName}修改中 · ${subject}` : `${input.targetName}修改中`,
    chip: `${input.targetName}修改中${places ? ` · ${places}` : ''}`,
    action: action('cancel-request', '取消修改', '取消'),
  };
}

/** Cancellation, including a withdrawn-but-running run, is handled before any execution state is described. */
type ExecutionState = Exclude<
  NonNullable<ModificationProgressInput['view']['execution']>['state'],
  'withdrawn_running'
>;

function describeExecution(
  input: ModificationProgressInput,
  execution: ExecutionState,
): ModificationProgressCopy | null {
  switch (execution) {
    case 'queued':
      return queued(input.targetName);
    case 'starting':
    case 'running':
      return describeWorking(input);
    case 'finished':
      return input.view.candidates.length > 0
        ? null
        : {
            key: 'finished_without_version',
            indicator: 'neutral',
            title: '执行已结束，尚无新版本',
            detail: '暂无可审阅的版本。',
          };
    case 'failed':
      return incomplete('执行失败，修改说明已保留。', true);
    case 'interrupted':
      return incomplete('执行已中断，修改说明已保留。', true);
    case 'cancelled':
      // The invocation was stopped or the carrier withdrawn before a run: the request itself is still valid.
      return incomplete('执行已取消，修改说明已保留。', true, 'attention');
    case 'unknown':
      return unavailable();
  }
}

/**
 * No execution has been observed yet: the request is still on its way to the cat, or it never got there.
 * The board draws none of these stages, so the wording stays plain and avoids internal terms.
 */
function describeStage(input: ModificationProgressInput): ModificationProgressCopy {
  const { view, targetName } = input;
  if (view.record.issue && view.stage !== 'queued' && view.stage !== 'cancelled') {
    return incomplete('修改说明已保留。');
  }
  switch (view.stage) {
    case 'accepted':
      return { key: 'accepted', indicator: 'neutral', title: '已接下原审片意见' };
    case 'saving_source':
    case 'preparing_content':
    case 'admitting_task':
    case 'binding_request':
      return { key: 'submitting', indicator: 'spinner', title: '正在提交修改', action: cancelRequest() };
    case 'pending_delivery':
      return {
        key: 'delivering',
        indicator: 'neutral',
        title: '等待送达',
        detail: `修改说明已保存，尚未交给${targetName}。`,
        action: cancelRequest(),
      };
    case 'queued':
      return queued(targetName);
    case 'cancelled':
      // Reached only without an owner cancellation record, so this is the delivery intent being cancelled.
      return incomplete('投递已取消，修改说明已保留。', false, 'attention');
    case 'retired':
      return incomplete('投递已停止，修改说明已保留。');
  }
}

/** `null` means the line has nothing left to say: a new version exists and its own record takes over. */
export function describeModificationProgress(input: ModificationProgressInput): ModificationProgressCopy | null {
  const execution = input.view.execution?.state;
  if (input.view.record.control) return describeCancellation(execution);
  if (execution === 'withdrawn_running') return describeWithdrawal();
  return execution ? describeExecution(input, execution) : describeStage(input);
}
