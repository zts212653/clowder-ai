import type { MessageSearchNotice } from './message-search.js';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function qualificationCounts(q: Record<string, unknown>): MessageSearchNotice['counts'] {
  const { examined, supported, rejected, indeterminate, unassessed } = q;
  if (
    isCount(examined) &&
    isCount(supported) &&
    isCount(rejected) &&
    isCount(indeterminate) &&
    isCount(unassessed) &&
    supported + rejected + indeterminate + unassessed === examined
  ) {
    return {
      candidates: examined,
      assessed: examined - unassessed,
      supported,
      rejected,
      indeterminate,
      unassessed,
    };
  }
  return undefined;
}

function summary(counts: MessageSearchNotice['counts'], shown: number): string {
  if (!counts) return '本次资格核对情况未知，不能据此判断历史没有相关消息。';
  const { candidates, unassessed, indeterminate, rejected } = counts;
  if (candidates === 0) return '本次未取得可评估候选，不能据此判断历史没有相关消息。';
  if (unassessed === candidates) return '本次候选全部尚未评估，不能据此判断历史没有相关消息。';
  if (unassessed || indeterminate)
    return shown
      ? `目前显示 ${shown} 处可读匹配，部分候选尚未核对完。`
      : '部分候选尚未核对完，不能据此判断历史没有相关消息。';
  if (rejected === candidates) return `本次核对的 ${candidates} 条候选均不支持查询，不代表历史没有相关消息。`;
  return `本次已核对 ${candidates} 条候选，显示 ${shown} 处可读匹配。`;
}

function execution(q: Record<string, unknown>, counts: MessageSearchNotice['counts']): string | undefined {
  if (!counts) return undefined;
  const { started, completed, cancelled, failed } = record(q.batches);
  if (
    isCount(started) &&
    isCount(completed) &&
    isCount(cancelled) &&
    isCount(failed) &&
    started <= 2 &&
    completed + cancelled + failed === started
  ) {
    if (started > 0) return `评估批次：启动 ${started}，完成 ${completed}，取消 ${cancelled}，失败 ${failed}。`;
    if (counts.unassessed > 0) return '本次没有启动评估批次；未启动的具体原因未提供。';
  }
  return undefined;
}

/** Shared cat/UI explanation; derives no cause from counts and grants no candidate access. */
export function messageSearchNotice(input: { results: readonly unknown[]; meta?: unknown }): MessageSearchNotice {
  const meta = record(input.meta),
    q = record(meta.qualification);
  if (meta.resultKind === 'sources') return sourceNotice(input.results.length, meta);
  if (meta.resultKind === 'selected-answer') {
    return {
      summary: `本卡显示猫选出的 ${input.results.length} 处来源；系统核验原句与结构归属，选用理由由选材猫判断。`,
      coverage:
        '本卡没有重新搜索，也不证明已查全历史。' +
        (record(meta.response).truncated || meta.hasMore || meta.partial
          ? '部分选材受当前可读性或返回预算限制，未在本卡显示。'
          : ''),
      nextStep: '打开原文，结合标题、条件、引文与当条批注核对选用理由。',
    };
  }
  const counts = qualificationCounts(q);
  const batchExecution = execution(q, counts);
  const notice: MessageSearchNotice = {
    summary: summary(counts, input.results.length),
    ...(counts ? { counts } : {}),
    ...(batchExecution !== undefined ? { execution: batchExecution } : {}),
    coverage: '索引覆盖范围尚未确认。最近消息可能尚未入索引，延迟暂无法确认。',
    nextStep: input.results.length
      ? '可先打开已显示的原文，取其中的日期、对话或正文原词，再缩小查找范围。'
      : '可补充已有的日期范围、对话或正文原词，缩小查找范围。',
  };
  const envelope = record(meta.response);
  if (envelope.truncated) notice.coverage += '返回受预算限制，仅显示部分结果，当前没有后续分页入口。';
  else if (meta.hasMore || meta.partial || meta.semanticCandidatesLimited)
    notice.coverage += '仅列出本次可得的部分命中。';
  return notice;
}

function sourceNotice(shown: number, meta: Record<string, unknown>): MessageSearchNotice {
  const window = record(meta.timeWindow);
  let coverage = '索引覆盖范围尚未确认。最近消息可能尚未入索引，延迟暂无法确认。';
  if (meta.sort === 'time' && isCount(window.limit) && isCount(window.admitted)) {
    coverage += window.complete
      ? `按相关度取得前 ${window.limit} 条可读来源，再按时间排列；窗口外可能有更早的原文。`
      : `本次核完 ${window.admitted} 条来源，未读满 ${window.limit} 条相关窗口，仅按已核部分的时间排列。`;
  } else coverage += '按相关度列出本次可得的部分来源。';
  if (record(meta.response).truncated) coverage += '返回受预算限制，当前没有后续分页入口。';
  else if (meta.hasMore && meta.sort === 'time') coverage += '仅列出本次可得的部分来源。';
  return {
    summary: shown
      ? `找到 ${shown} 处可打开的原文，请结合内容和上下文判断。`
      : '本次没有可显示的原文，不能据此判断历史没有相关消息。',
    coverage,
    nextStep: shown ? '打开原文核对内容、原说话者和上下文。' : '可结合已有线索调整查询或查找范围。',
  };
}
