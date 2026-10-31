import type { ExplorationRequestContext } from './exploration-reading';

export const explorationIntentLabels = { explore: '探索改进', retest: '补测这一版', adopt: '请求采用这一版' } as const;

export function explorationRequestText(context: ExplorationRequestContext): string {
  // Native user-message routing excludes quoted source text, including @ handles in a draft or title.
  const quote = (text: string) =>
    text
      .split(/\r\n?|\n|\u2028|\u2029/)
      .map((line) => `> ${line}`)
      .join('\n');
  const target = { objectRef: context.objectRef, cycle: context.cycle, ...context.binding };
  return `@${context.catId}\n请在现有能力项目 ${context.programId} 继续${explorationIntentLabels[context.draft.intent]}。\n${quote(context.draft.text)}\n\n发起时固定的阅读对象（后续切换阅读不会改写此对象）：\n${quote(JSON.stringify(target, null, 2))}\n\n先核对同一 Program、object、版本/归档和实验 refs；公开归档仍是公开开发材料，不是正式资产、独立验收或采用。沿本对话已有任务及 owner 授权/审批执行，准备内容继续用现有提交协议；补测归回原版本，未产出请求不增加节点。本请求不新增训练、费用或 Goal，不替代采用批准或 owner 生效回执。请回真实动作、原始结果/回放、等待内容与剩余缺口；若责任已交接，核对当前责任后沿原链路接续。`;
}
