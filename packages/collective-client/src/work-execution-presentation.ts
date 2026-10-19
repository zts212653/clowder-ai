import type { CollectiveWorkProjection } from './client-types.js';

export function workStatusLabel(status: CollectiveWorkProjection['status']): string {
  const labels: Record<CollectiveWorkProjection['status'], string> = {
    proposed: '等待确认',
    unassigned: '待指派',
    ready: '可以开始',
    blocked: '等待前置任务',
    in_progress: '进行中',
    result_ready: '结果待确认',
    completed: '已完成',
    declined: '不跟踪',
    cancelled: '已取消',
  };
  return labels[status];
}

/** Live Service permission and current Host receipt govern execution; first acceptance stays historical. */
export function workExecutionPresentation(work: CollectiveWorkProjection): {
  readonly statusLabel: string;
  readonly assignmentAction: '推进' | '已接下';
  readonly admissionMessage?: string;
} {
  const currentExecution = work.executionAuthority ?? work.acceptance;
  const active = work.lifecycle === 'committed' || work.lifecycle === 'in_progress';
  const currentStatus = work.executionStatus;
  if (
    active &&
    currentStatus?.revision === (work.executionAuthority?.revision ?? 1) &&
    currentStatus.state === 'unavailable'
  ) {
    return {
      statusLabel: '当前无法执行',
      assignmentAction: '已接下',
      admissionMessage: executionUnavailableMessage(currentStatus.reason),
    };
  }
  if (!currentExecution) return { statusLabel: workStatusLabel(work.status), assignmentAction: '推进' };
  const admission = currentExecution.hostAdmission;
  const assignmentAction =
    admission?.state === 'admitted' && work.lifecycle === 'in_progress' && work.status === 'in_progress'
      ? '推进'
      : '已接下';
  if (!active) {
    return { statusLabel: workStatusLabel(work.status), assignmentAction };
  }
  if (admission?.state === 'rejected') {
    return {
      statusLabel: '暂时不能执行',
      assignmentAction,
      admissionMessage: rejectedAdmissionMessage(admission.reason),
    };
  }
  if (!admission) return { statusLabel: '已接下，待家内准入', assignmentAction };
  return {
    statusLabel:
      work.lifecycle === 'committed' && work.status !== 'blocked' ? '已准入，待开始' : workStatusLabel(work.status),
    assignmentAction,
  };
}

function executionUnavailableMessage(reason?: string): string {
  switch (reason) {
    case 'WORK_DELEGATION_UNAVAILABLE':
      return '当前委托已经不可用，暂时不能继续。';
    case 'PARTICIPATION_REVOKED':
      return '猫的公共参与已撤回，当前无法继续执行。';
    case 'WORK_SOURCE_UNAVAILABLE':
      return '来源消息或相关成员已不可用，当前无法继续执行。';
    case 'MEMBERSHIP_REVOKED':
      return '相关成员已退出或被移除，当前无法继续执行。';
    case 'WORK_ADMISSION_NOT_CURRENT':
      return '当前执行的家内准入已失效，无法继续执行。';
    case 'CONNECTION_REVOKED':
      return '所属 Café 的连接已撤回，当前无法继续执行。';
    default:
      return '暂时不能继续。回原讨论查看下一步。';
  }
}

function rejectedAdmissionMessage(reason?: string): string {
  switch (reason) {
    case 'PARTICIPATION_REVOKED':
      return '这只猫已不再参与，暂时不能执行。';
    case 'CONNECTION_REVOKED':
      return '所属 Café 的连接已撤回，暂时不能执行。';
    case 'MEMBERSHIP_REVOKED':
      return '相关成员已退出或被移除，暂时不能执行。';
    case 'WORK_SOURCE_UNAVAILABLE':
      return '原讨论已不可用，暂时不能执行。';
    case 'WORK_ADMISSION_NOT_CURRENT':
      return '这次允许已经失效，暂时不能执行。';
    case 'WORK_DELEGATION_UNAVAILABLE':
      return '当前委托已经不可用，暂时不能执行。';
    default:
      return '暂时不能执行。回原讨论查看下一步。';
  }
}
