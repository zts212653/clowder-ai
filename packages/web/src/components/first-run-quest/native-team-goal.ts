export interface GoalPartner {
  id: string;
  name: string;
  mention: string;
}

export function orderGoalPartners<T extends { id: string }>(partners: readonly T[], lead: string): T[] {
  const first = partners.find((partner) => partner.id === lead);
  return first ? [first, ...partners.filter((partner) => partner !== first)] : [...partners];
}

export function goalRole(index: number, total: number): { title: string; instruction: string } {
  if (index === 0) return { title: '提出方案', instruction: '先给出一版简短、可执行的方案，留给后续伙伴检查。' };
  if (index === total - 1)
    return {
      title: '检查并汇总',
      instruction: '检查前面伙伴的方案，明确采纳或修正了哪些建议，汇总为用户可直接使用的最终结果。',
    };
  return { title: '补充与检查', instruction: '阅读前面伙伴的结果，指出遗漏或风险，并给出具体改进，避免重复原方案。' };
}

/** Explicit mentions enlist every selected member; #execute uses the existing serial worklist. */
export function buildNativeTeamGoal(partners: readonly GoalPartner[], goal: string): string {
  if (!partners.length) throw new Error('至少选择一位伙伴');
  if (partners.length === 1) return `${partners[0].mention} ${goal.trim()}`;
  return [
    partners.map((partner) => partner.mention).join(' '),
    goal.trim(),
    '',
    '请按以下分工依次协作，每位只完成自己的这一棒：',
    ...partners.map(
      (partner, index) =>
        `${index + 1}. ${partner.name}（${partner.mention}）：${goalRole(index, partners.length).instruction}`,
    ),
    '系统会依次唤起以上伙伴，无需再次召唤。后续伙伴请基于本对话中前序伙伴的实际回复继续；若未收到回复，请如实说明，不要代替其他伙伴发言。',
    '#execute',
  ].join('\n');
}
