'use client';
import type { ContentModificationCompletionRule, ContentModificationRequestView } from '@cat-cafe/shared';
import { useEffect } from 'react';

import { ContentModificationForm } from './ContentModificationForm';
import { ContentModificationResults } from './ContentModificationResults';
import { ContentSourceDiscussions } from './ContentSourceDiscussions';
import { modificationStorageKey } from './modification-draft';
import { modificationFailureMessage } from './modification-http';
import { type ContentModificationModel, useContentModification } from './useContentModification';

type Props = Parameters<typeof useContentModification>[0] & {
  title: string;
  mediaType?: string;
  onClose: () => void;
  completionRule?: ContentModificationCompletionRule;
  onRequestKnown?: (request: ContentModificationRequestView) => void;
};
export function ContentModificationPanel(props: Props) {
  // An owner/object switch unmounts pending UI work; a version change on the same object preserves its draft.
  return (
    <ModificationPanel
      key={`${modificationStorageKey(props.ownerUserId, props.source)}:${props.contextKey ?? ''}`}
      {...props}
    />
  );
}

function ModificationPanel(props: Props) {
  const model = useContentModification(props);
  const status = model.view ?? model.sent;
  useEffect(() => {
    if (status) props.onRequestKnown?.(status);
  }, [status, props.onRequestKnown]);
  const rule =
    props.completionRule ?? (props.source.kind === 'workspace' ? 'file-writeback-applied' : 'published-result-ready');
  const hasWriteback = model.view?.writeback || props.source.kind === 'workspace';
  const fulfilled = hasWriteback
    ? model.view?.acceptances.some((item) => item.receipt?.state === 'applied')
    : Boolean(model.view?.candidates.length);
  return (
    <aside
      className="max-h-[70%] shrink-0 overflow-auto border-t border-cafe-subtle bg-cafe-surface p-3 text-cafe"
      aria-label="请猫修改作品"
      data-modification-open
      data-testid="content-modification-panel"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="min-w-0 truncate font-semibold">修改《{props.title}》</h3>
        <button
          type="button"
          onClick={props.onClose}
          aria-label="收起修改面板"
          className="shrink-0 text-xs text-cafe-muted"
        >
          收起
        </button>
      </div>
      {model.error ? (
        <p role="alert" className="mb-3 text-sm text-cafe-error">
          {model.error}
        </p>
      ) : null}
      <ModificationStatus model={model} />
      {model.view?.sourceDiscussions?.length ? (
        <ContentSourceDiscussions discussions={model.view.sourceDiscussions} />
      ) : null}
      {model.ready && (!status ? !model.draft.requestId : !status.record.control && status.record.issue?.retryable) ? (
        <ContentModificationForm model={model} mediaType={props.mediaType} rule={rule} />
      ) : null}
      {model.view ? (
        <ContentModificationResults
          view={model.view}
          busy={model.busy || Boolean(model.draft.cancellationPending)}
          onAccept={model.accept}
          onReject={model.reject}
          pendingRejections={model.draft.rejectionPending}
        />
      ) : null}
      {model.draft.requestId && status && !status.record.control && !fulfilled ? (
        <button
          type="button"
          data-testid="content-modification-cancel"
          className="mt-3 text-sm text-cafe-muted underline"
          disabled={model.cancelDisabled}
          onClick={() => void model.cancel()}
        >
          {model.draft.cancellationPending ? '核对并重试取消' : '取消本次修改'}
        </button>
      ) : null}
    </aside>
  );
}

const stageLabels = {
  saving_source: '正在保存修改请求',
  preparing_content: '请求已保存，正在准备作品',
  admitting_task: '作品已准备，正在登记委托',
  binding_request: '已登记委托，投递尚未完成',
  pending_delivery: '已登记委托，等待投递',
  queued: '已排队，等待执行',
  cancelled: '本次修改请求已取消',
  retired: '本次投递已停止',
} as const;
const executionLabels = {
  queued: '已排队，等待执行',
  starting: '正在启动执行',
  running: '正在执行',
  finished: '本轮执行已结束，等待作品结果',
  failed: '本轮执行失败',
  cancelled: '本轮执行已取消',
  interrupted: '本轮执行已中断',
  withdrawn_running: '请求已撤回，执行尚未停止',
  unknown: '执行状态暂不可核验',
} as const;
function ModificationStatus({ model }: { model: ContentModificationModel }) {
  const status = model.view ?? model.sent;
  if (!status)
    return !model.ready || model.draft.requestId ? (
      <div className="mb-3 space-y-2 text-sm text-cafe-muted">
        <p role="status">{model.draft.requestId ? '正在读取原请求状态，修改说明仍保留。' : '正在读取原位草稿…'}</p>
        {model.draft.requestId ? (
          <button
            type="button"
            disabled={model.busy || !model.ready}
            onClick={() => void model.refresh().catch(() => undefined)}
          >
            重新读取请求
          </button>
        ) : null}
      </div>
    ) : null;
  const runningAfterCancel =
    status.record.control && (status.execution?.state === 'running' || status.execution?.state === 'withdrawn_running');
  const label = status.record.control
    ? runningAfterCancel
      ? `本次修改请求已取消；${model.target?.name ?? '原执行猫'}的本轮执行仍在继续`
      : stageLabels.cancelled
    : model.view?.candidates.length
      ? '新版结果已返回'
      : status.execution
        ? executionLabels[status.execution.state]
        : stageLabels[status.stage];
  return (
    <div className="mb-3 space-y-2">
      <p>
        <output>
          {model.error ? '上次读到：' : ''}
          {label}
          {model.target && !runningAfterCancel ? ' · ' + model.target.name : ''}
        </output>
      </p>
      {status.record.control ? (
        <div className="space-y-1 text-sm text-cafe-muted">
          <p>候选和历史已保留；本次请求不能再接受新的写回。</p>
          {model.view?.acceptances.length ? <p>已确认的写回不会撤销；其结果见下方文件回执。</p> : null}
          {status.execution && !runningAfterCancel ? (
            <p>{status.execution.state === 'finished' ? '本轮执行已结束' : executionLabels[status.execution.state]}</p>
          ) : !status.execution ? (
            <p>投递与执行状态仍以实际回执为准。</p>
          ) : null}
          {status.record.control.taskResolution === 'preserved' ? <p>原委托保留；仅取消本次修改。</p> : null}
          {status.record.control.taskResolution === 'unknown' ? <p>接责情况仍在核对。</p> : null}
        </div>
      ) : null}
      {status.record.issue ? (
        <p className="text-sm text-cafe-muted">
          {modificationFailureMessage(status.record.issue.code)} {status.record.issue.detail}
        </p>
      ) : null}
      <details className="text-xs text-cafe-muted">
        <summary>原修改说明</summary>
        <p className="whitespace-pre-wrap">{model.draft.body}</p>
        <p>
          {model.target?.name ?? model.draft.targetCatId} · {model.thread?.title ?? '原执行对话'}
        </p>
      </details>
    </div>
  );
}
