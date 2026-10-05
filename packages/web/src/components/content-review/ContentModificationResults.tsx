'use client';

import type { ContentModificationCandidate, ContentModificationDetailView } from '@cat-cafe/shared';
import { ContentModificationCandidatePreview } from './ContentModificationCandidatePreview';
import { ModificationMediaCompare } from './media-compare/ModificationMediaCompare';

export function ContentModificationResults({
  view,
  busy,
  onAccept,
  onReject,
  pendingRejections,
}: {
  view: ContentModificationDetailView;
  busy: boolean;
  onAccept: (candidateRef: string) => Promise<void>;
  onReject?: (candidateRef: string) => Promise<void>;
  pendingRejections?: readonly string[];
}) {
  return (
    <div className="space-y-4" data-testid="content-modification-results">
      {view.candidates.map((candidate) => (
        <ContentModificationResult
          key={candidate.candidateRef}
          candidate={candidate}
          view={view}
          busy={busy}
          onAccept={onAccept}
          onReject={onReject}
          rejectionPending={pendingRejections?.includes(candidate.candidateRef) ?? false}
        />
      ))}
    </div>
  );
}

function ContentModificationResult({
  candidate,
  view,
  busy,
  onAccept,
  onReject,
  rejectionPending,
}: {
  candidate: ContentModificationCandidate;
  view: ContentModificationDetailView;
  busy: boolean;
  onAccept: (candidateRef: string) => Promise<void>;
  onReject?: (candidateRef: string) => Promise<void>;
  rejectionPending: boolean;
}) {
  const acceptance = view.acceptances.find((item) => item.acceptance.candidateRef === candidate.candidateRef);
  const receipt = acceptance?.receipt;
  const applied = receipt?.state === 'applied';
  const rejected = view.rejections?.find((item) => item.candidateRef === candidate.candidateRef);
  const stateText = writebackStatus(acceptance);
  return (
    <article className="space-y-3 rounded-lg border border-cafe-subtle p-3" data-testid="content-modification-result">
      <p className="text-sm font-semibold">
        新版已返回 ·{' '}
        {candidate.kind === 'media' ? `v${candidate.asset.ownerRevision}` : `候选 ${candidate.proposal.revision}`}
      </p>
      {candidate.kind === 'media' ? (
        <ModificationMediaCompare candidate={candidate} view={view} />
      ) : (
        <ContentModificationCandidatePreview candidate={candidate} />
      )}
      {rejected ? <p className="text-sm text-cafe-muted">已拒绝此候选；候选和原讨论仍保留。</p> : null}
      {stateText ? <output className="block text-sm text-cafe-muted">{stateText}</output> : null}
      {(view.writeback || view.record.payload.source.kind === 'workspace') &&
      (!view.record.control || acceptance) &&
      !rejected &&
      !applied &&
      receipt?.state !== 'conflict' &&
      receipt?.state !== 'unknown' ? (
        <button
          type="button"
          data-testid="content-modification-accept"
          className="rounded-lg bg-cafe-accent px-3 py-1.5 text-sm text-[var(--cafe-accent-foreground)]"
          disabled={busy || rejectionPending || (view.writeback?.writable === false && !acceptance)}
          onClick={() => void onAccept(candidate.candidateRef)}
        >
          {acceptance ? '重试原写回操作' : '采用并写回'}
        </button>
      ) : null}
      {onReject &&
      !rejected &&
      !acceptance &&
      !view.record.control &&
      (view.writeback || view.record.payload.source.kind === 'workspace') ? (
        <button
          type="button"
          data-testid="content-modification-reject"
          disabled={busy}
          onClick={() => void onReject(candidate.candidateRef)}
          className="rounded-md px-3 py-2 text-sm text-cafe-muted underline"
        >
          {rejectionPending ? '核对并重试拒绝' : '不采用'}
        </button>
      ) : null}
      <details className="break-all text-xs text-cafe-muted">
        <summary>版本详情</summary>
        <dl>
          <dt>具名返回者</dt>
          <dd>{candidate.kind === 'media' ? candidate.authorCatId : candidate.proposal.authorCatId}</dd>
          <dt>版本回执</dt>
          <dd>{candidate.candidateRef}</dd>
          {receipt ? (
            <>
              <dt>本次写出的版本</dt>
              <dd>{receipt.writtenRevision ?? '尚未确认写入'}</dd>
              <dt>文件当前版本</dt>
              <dd>{receipt.currentRevision}</dd>
            </>
          ) : null}
        </dl>
      </details>
    </article>
  );
}

function writebackStatus(acceptance: ContentModificationDetailView['acceptances'][number] | undefined): string | null {
  if (!acceptance) return null;
  const receipt = acceptance.receipt;
  if (!receipt) return '写回回执暂不可读取；候选已保留。';
  switch (receipt.state) {
    case 'applied':
      return receipt.currentRevision === receipt.writtenRevision ? '已写回原文件' : '本次已写回；文件随后又有改动。';
    case 'conflict':
      return '原文件已有改动，尚未写回；新版本已保留。';
    case 'unknown':
      return '写回结果无法确定；新版本已保留，请核对原文件。';
    default:
      return '接受操作已记录，写回尚未完成。';
  }
}
