import type { ApprovalMaterialization } from '@cat-cafe/shared';
import type { ShellLanguage } from '../shell-language';
import type { ReconcileState, ReconcileView, Terminal, WriteSeen } from './approval-reconcile';
import { approvalReconcileCopy } from './approval-reconcile.shell-copy';
import { readTerminal } from './approval-reconcile-terminal';
import { originalApprovalCopy } from './original-approval.shell-copy';
import type { OriginalApprovalEffect } from './use-original-approval-effect';

type Context = {
  language?: ShellLanguage;
  ownerUserId?: string;
  sourceFeatureId?: string;
  originalEffect?: OriginalApprovalEffect | null;
  compactResult?: boolean;
  materialization?: ApprovalMaterialization;
};
type Copy = typeof approvalReconcileCopy.zh;

function writeOutcome(write: WriteSeen | undefined): keyof Copy['confirming'] {
  const outcome = write?.outcome;
  return outcome === 'accepted' || outcome === 'ended' || outcome === 'errored' ? outcome : 'unknown';
}

function decidedLine(terminal: Terminal, t: Copy, context: Context): string {
  const verified = readTerminal(terminal);
  if (!verified) return t.unknown;
  const original = originalApprovalCopy[context.language ?? 'zh'];
  const effect = verified.resolution === 'accepted' ? context.originalEffect : null;
  const originalResult =
    effect === 'handoff-started'
      ? original.handoffApproved
      : effect === 'profile-written'
        ? original.approvedProfile
        : verified.resolution === 'rejected' && context.sourceFeatureId === 'F225'
          ? original.handoffRejected
          : null;
  const parts = [
    originalResult ??
      (verified.closedReason ? t.closedReasons[verified.closedReason] : t.resolutions[verified.resolution]),
  ];
  if (verified.threadId) parts.push(t.opened);
  if (effect && !originalResult) parts.push(t.originalEffects[effect]);
  else if (!effect && !verified.threadId && verified.resolution === 'accepted') {
    if (context.materialization?.state === 'in_progress') parts.push(t.inProgress);
    else if (context.materialization?.state === 'failed')
      parts.push(
        ['F221', 'F231', 'F260', 'F276', 'F321'].includes(context.sourceFeatureId ?? '') ? t.writeFailed : t.failed,
      );
    else if (verified.effectUnknown) parts.push(t.effectUnknown);
  }
  if (verified.decidedAt !== undefined && !context.compactResult) {
    parts.push(
      new Date(verified.decidedAt).toLocaleString(context.language === 'en' ? 'en-US' : 'zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }),
    );
  }
  // A canonical actor id is evidence, not a display name. Only the verified
  // current owner's exact identity supports "you"; retain the raw id in state.
  if (verified.decidedBy && !context.compactResult)
    parts.push(verified.decidedBy === context.ownerUserId ? t.you : t.deciderUnavailable);
  return parts.join(' · ');
}

/** Format the proven result; language and readable actors never change write eligibility. */
export function describeReconcile(state: ReconcileState, context: Context = {}): ReconcileView {
  const t = approvalReconcileCopy[context.language ?? 'zh'];
  switch (state.kind) {
    case 'idle':
      return { line: null, actions: 'allowed', canReread: false };
    case 'writing':
      return { line: t.writing, actions: 'held', canReread: false };
    case 'confirming':
      return { line: t.confirming[writeOutcome(state.write)], actions: 'held', canReread: false };
    case 'still_open':
      return {
        line: t.stillOpen[writeOutcome(state.write)],
        actions:
          !state.write ||
          state.write.outcome === 'unknown' ||
          state.write.outcome === 'ended' ||
          (state.write.outcome === 'errored' && state.write.status >= 500)
            ? 'held'
            : 'allowed',
        canReread: true,
      };
    case 'decided':
      return {
        line: decidedLine(state.terminal, t, context),
        actions: 'gone',
        canReread: state.terminal?.effectUnknown === true,
      };
    case 'unconfirmed':
      return {
        line: state.why === 'left_the_list' ? t.left : state.why === 'not_aligned' ? t.notAligned : t.unknown,
        actions: 'held',
        canReread: true,
      };
    case 'needs_login':
      return { line: t.needsLogin, actions: 'held', canReread: true };
    case 'no_permission':
      return { line: t.noPermission, actions: 'held', canReread: true };
    case 'refused_before_send':
      return { line: t.refused, actions: 'allowed', canReread: false };
    default:
      return { line: t.unknown, actions: 'held', canReread: true };
  }
}
