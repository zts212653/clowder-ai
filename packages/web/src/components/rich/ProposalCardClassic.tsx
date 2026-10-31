'use client';

import { MarkdownContent } from '@/components/MarkdownContent';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import type { RichCardBlock } from '@/stores/chat-types';
import { CafeIcon } from './CafeIcons';
import {
  DeclaredWorkModeEdit,
  displayProposalTitle,
  EditField,
  ProjectPathEdit,
  ProposalCardIcon,
  ReportingModeEdit,
} from './ProposalCardFields';
import type { ProposalCardState } from './useProposalCardState';

/** The original Chat presentation; the state and producer writes are shared with the mailbox. */
export function ProposalCardClassic({ block, state }: { block: RichCardBlock; state: ProposalCardState }) {
  const {
    status,
    resultThreadId,
    editing,
    setEditing,
    loading,
    error,
    pinOnApprove,
    setPinOnApprove,
    writeBlocked,
    edits,
    setEdits,
    projectOwnership,
    reportingMode,
    declaredWorkMode,
    needsProjectChoice,
    existingProjects,
    approve,
    reject,
  } = state;
  if (!state.proposalId) {
    return (
      <div className="border-l-4 border-l-red-400 bg-[var(--semantic-critical-surface)] rounded-r-lg p-3 text-xs text-conn-red-text">
        Proposal card missing proposalId
      </div>
    );
  }

  return (
    <div className="border-l-4 border-l-blue-400 bg-[var(--semantic-info-surface)] rounded-r-lg p-3">
      <div className="flex items-start gap-2">
        <ProposalCardIcon />
        <div className="font-medium text-sm">{displayProposalTitle(block.title)}</div>
      </div>
      {block.bodyMarkdown && (
        <div className="mt-1 text-xs text-cafe-secondary [&_p]:mb-1 [&_p:last-child]:mb-0">
          <MarkdownContent content={block.bodyMarkdown} className="!text-xs" disableCommandPrefix />
        </div>
      )}
      {!editing && (
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1 text-xs">
          <div>
            <span className="text-cafe-muted">父 Thread:</span>{' '}
            <span className="font-mono break-all">{edits.parentThreadId}</span>
          </div>
          <div>
            <span className="text-cafe-muted">建议成员:</span>{' '}
            <span className="font-mono break-all">{edits.preferredCats || '（未指定）'}</span>
          </div>
          <div className="sm:col-span-2">
            <span className="text-cafe-muted">协作方式:</span> <span>{declaredWorkMode}</span>
          </div>
          <div className="sm:col-span-2">
            <span className="text-cafe-muted">回报模式:</span> <span>{reportingMode}</span>
          </div>
          {projectOwnership && (
            <div className="sm:col-span-2">
              <span className="text-cafe-muted">项目归属:</span>{' '}
              <span className="font-mono break-all">{projectOwnership}</span>
            </div>
          )}
          {edits.initialMessage && (
            <div className="sm:col-span-2">
              <span className="text-cafe-muted">首条消息:</span> <span>{edits.initialMessage}</span>
            </div>
          )}
        </div>
      )}
      {needsProjectChoice && !editing && (
        <div className="mt-2 rounded border border-[var(--semantic-warning)] bg-[var(--semantic-warning-surface)] px-2 py-1 text-xs text-cafe-secondary">
          这个子 thread 会进入未分类。点“编辑”选择项目，或直接批准表示保留未分类。
        </div>
      )}
      {editing && (
        <div className="mt-2 space-y-1 text-xs">
          <EditField label="标题" value={edits.title} onChange={(v) => setEdits((p) => ({ ...p, title: v }))} />
          <EditField
            label="父 Thread"
            value={edits.parentThreadId}
            onChange={(v) => setEdits((p) => ({ ...p, parentThreadId: v }))}
          />
          <ProjectPathEdit
            value={edits.projectPath}
            onChange={(v) => setEdits((p) => ({ ...p, projectPath: v }))}
            existingProjects={existingProjects}
            defaultParent={needsProjectChoice}
          />
          <ReportingModeEdit
            value={edits.reportingMode}
            onChange={(v) => setEdits((p) => ({ ...p, reportingMode: v }))}
          />
          <DeclaredWorkModeEdit
            value={edits.declaredWorkMode}
            onChange={(value) => setEdits((previous) => ({ ...previous, declaredWorkMode: value }))}
          />
          <EditField
            label="建议成员 (逗号分隔)"
            value={edits.preferredCats}
            onChange={(v) => setEdits((p) => ({ ...p, preferredCats: v }))}
          />
          <EditField
            label="首条消息"
            value={edits.initialMessage}
            onChange={(v) => setEdits((p) => ({ ...p, initialMessage: v }))}
            multiline
          />
        </div>
      )}
      {status === 'pending' && (
        <div className="mt-2 space-y-2">
          <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
            <input
              type="checkbox"
              checked={pinOnApprove}
              onChange={(e) => setPinOnApprove(e.target.checked)}
              className="rounded border-gray-300 dark:border-gray-600"
            />
            <CafeIcon name="pin" className="h-3.5 w-3.5 text-cafe-muted" />
            置顶新 thread
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={writeBlocked} onClick={approve} className={btnPrimary}>
              {loading
                ? '处理中...'
                : editing
                  ? '批准（含编辑）'
                  : needsProjectChoice
                    ? '批准并创建（保留未分类）'
                    : '批准并创建'}
            </button>
            <button type="button" disabled={loading} onClick={() => setEditing((v) => !v)} className={btnSecondary}>
              {editing ? '取消编辑' : '编辑'}
            </button>
            <button type="button" disabled={writeBlocked} onClick={reject} className={btnDanger}>
              驳回
            </button>
          </div>
        </div>
      )}
      {status === 'approving' && <div className="mt-2 text-xs text-[var(--semantic-info)] ">批准中…</div>}
      {status === 'approved' && (
        <div className="mt-2 flex items-center gap-1 text-xs text-conn-emerald-text">
          <CafeIcon name="check" className="h-3.5 w-3.5 shrink-0" />
          已批准，thread 已创建{' '}
          {resultThreadId ? (
            <button
              type="button"
              data-testid="thread-link"
              onClick={() =>
                pushThreadRouteWithHistory(resultThreadId, typeof window !== 'undefined' ? window : undefined)
              }
              className="font-mono underline text-conn-emerald-text hover:opacity-80 cursor-pointer"
            >
              {resultThreadId}
            </button>
          ) : null}
        </div>
      )}
      {status === 'rejected' && (
        <div className="mt-2 flex items-center gap-1 text-xs text-conn-red-text">
          <CafeIcon name="cross" className="h-3.5 w-3.5 shrink-0" />
          已驳回
        </div>
      )}
      {status === 'withdrawn' && (
        <div className="mt-2 flex items-center gap-1 text-xs text-cafe-secondary">
          <CafeIcon name="cross" className="h-3.5 w-3.5 shrink-0" />
          已撤回（由发起猫）
        </div>
      )}
      {error && <div className="mt-1 text-xs text-conn-red-text">{error}</div>}
    </div>
  );
}

const btnPrimary =
  'text-xs px-3 py-1 rounded bg-[var(--semantic-info)] hover:opacity-90 text-[var(--cafe-surface)] disabled:opacity-50 transition-colors';
const btnSecondary =
  'text-xs px-3 py-1 rounded bg-cafe-surface-elevated hover:bg-[var(--console-hover-bg)] dark:hover:bg-gray-700 text-cafe-secondary border border-[var(--console-border-soft)] disabled:opacity-50 transition-colors';
const btnDanger =
  'text-xs px-3 py-1 rounded bg-[var(--semantic-critical-surface)] hover:bg-red-200 dark:hover:bg-red-800/50 text-conn-red-text border border-[var(--semantic-critical)] disabled:opacity-50 transition-colors';
