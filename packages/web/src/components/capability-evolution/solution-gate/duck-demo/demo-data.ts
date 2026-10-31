/** Isolated story fixture. No owner references or production results. */
export interface DemoRun {
  id: string;
  scheme: string;
  evaluation: string;
  sampleSet: string;
  observation: string;
  loaded: boolean;
  contact: boolean[] | null;
  goals: boolean[] | null;
  minutes: number;
}
export type VersionId = 'V1' | 'V2' | 'V3' | 'V4';
export const memberNames = {
  model: 'Model · 身体动作模型',
  body: '身体执行配置',
  control: 'Harness · 局部控制',
  config: 'Harness · 摆位参数',
  protocol: 'Harness · 指令协议',
  environment: '球场与物理条件',
  observation: '观测记录',
  rubric: '好坏规约',
  data: '开发场景',
};
export type MemberId = keyof typeof memberNames;
const base = {
  model: 'M1',
  body: 'B1',
  control: 'H1',
  config: 'C1',
  protocol: 'P1',
  environment: 'E1',
  observation: 'O1',
  rubric: 'R1',
  data: 'D1',
};
export interface DemoVersion {
  id: VersionId;
  title: string;
  parents: VersionId[];
  members: Record<MemberId, string>;
  change: string;
  why: string;
  limit: string;
}
export const versions: DemoVersion[] = [
  {
    id: 'V1',
    title: '球还在动，鸭先停了',
    parents: [],
    members: base,
    change: '先保留模型、局部控制和协议，跑六个公开场景。',
    why: '先看失败发生在观察、指令、摆位还是起脚；六例里四例能触球，说明整条链至少部分可用。',
    limit: '不能由此证明模型没有瓶颈，也还不知道是否进球。',
  },
  {
    id: 'V2',
    title: '持续跟球，配套调整摆位',
    parents: ['V1'],
    members: { ...base, control: 'H2', config: 'C2' },
    change: '局部控制 H1→H2，摆位参数 C1→C2；模型和协议保持原版。',
    why: '模拟片段里鸭在接近后停下，球继续滚。先试持续修正摆位与触发容差：改动成本低，也更贴近这个失败位置。',
    limit: '这是待检验的解释；两项一起改，只能先判断组合效果，不能分别归功。',
  },
  {
    id: 'V3',
    title: '先看清进球，再谈进步',
    parents: ['V1'],
    members: { ...base, observation: 'O2', rubric: 'R2' },
    change: '沿原控制分支增加整球越线观测 O2、有效进球规约 R2。',
    why: '触球可能踢偏。原来的尺子只回答碰没碰到，不能回答球进没进。',
    limit: '重新采集后得到 2/6 进球；不能拿它和 V1 的 4/6 触球比高低。',
  },
  {
    id: 'V4',
    title: '合并两条分支，同尺重测',
    parents: ['V2', 'V3'],
    members: { ...base, control: 'H2', config: 'C2', observation: 'O2', rubric: 'R2' },
    change: '采用 V2 的 H2/C2，带入 V3 的 O2/R2；其他成员逐项一致。',
    why: '把控制候选放到已明确的新判法下，与 V3 再比一次，才知道多触球是否换来了有效进球。',
    limit: '公开六例进球 2→3，右侧仍退步。新八例只验证左侧范围；协同能力和长期可靠性仍未知。',
  },
];
export const caseSets: Record<string, string[]> = {
  D1: ['左侧较近', '左侧较远', '左侧更宽', '右侧较近', '右侧较远', '右侧更宽'],
  D2: ['左侧新例 A', '左侧新例 B', '左侧新例 C', '左侧新例 D', '左侧新例 E', '左侧新例 F', '左侧新例 G', '左侧新例 H'],
};
export const demoRuns: DemoRun[] = [
  {
    id: 'X1',
    scheme: 'V1',
    evaluation: 'EV1',
    sampleSet: 'D1',
    observation: 'O1',
    loaded: true,
    contact: [true, false, false, true, true, true],
    goals: null,
    minutes: 8,
  },
  {
    id: 'X2',
    scheme: 'V2',
    evaluation: 'EV1',
    sampleSet: 'D1',
    observation: 'O1',
    loaded: true,
    contact: [true, true, true, true, true, false],
    goals: null,
    minutes: 10,
  },
  {
    id: 'X3',
    scheme: 'V2',
    evaluation: 'EV1',
    sampleSet: 'D1',
    observation: 'O1',
    loaded: false,
    contact: null,
    goals: null,
    minutes: 2,
  },
  {
    id: 'X4',
    scheme: 'V3',
    evaluation: 'EV2',
    sampleSet: 'D1',
    observation: 'O2',
    loaded: true,
    contact: [true, false, false, true, true, true],
    goals: [true, false, false, false, true, false],
    minutes: 8,
  },
  {
    id: 'X5',
    scheme: 'V4',
    evaluation: 'EV2',
    sampleSet: 'D1',
    observation: 'O2',
    loaded: true,
    contact: [true, true, true, true, true, false],
    goals: [true, true, false, false, true, false],
    minutes: 10,
  },
  {
    id: 'X6',
    scheme: 'V3',
    evaluation: 'EV2',
    sampleSet: 'D2',
    observation: 'O2',
    loaded: true,
    contact: [true, true, true, false, true, false, true, false],
    goals: [true, false, false, false, true, false, false, false],
    minutes: 12,
  },
  {
    id: 'X7',
    scheme: 'V4',
    evaluation: 'EV2',
    sampleSet: 'D2',
    observation: 'O2',
    loaded: true,
    contact: [true, true, true, true, true, true, true, false],
    goals: [true, true, false, true, true, false, true, false],
    minutes: 15,
  },
];
export const evaluations = {
  EV1: {
    title: '触球测试',
    rubric: 'R1',
    observation: 'O1',
    sees: '示例配置：50Hz 球位与动作阶段；200Hz 指定脚接触事件。未记录可核验的整球越线事件。',
    rule: 'R1：26 秒内，指定脚在踢球动作期与球实际接触，记为通过。走近、摆腿和球自行移动都不算。',
    verifier: '模拟器接触事件 → 指定脚/动作阶段 verifier → 通过场景数 / 完整场景数。未尝试和失败都进分母。',
  },
  EV2: {
    title: '有效进球测试',
    rubric: 'R2',
    observation: 'O2',
    sees: '保留 O1；新增 200Hz 球心、球半径、球门平面与边界记录，生成整球越线事件。',
    rule: 'R2：满足 R1 后，26 秒内整球从场内越过球门平面、位于球门宽高范围，才算有效进球。',
    verifier: '接触 verifier + 越线 verifier → 有效进球数 / 完整场景数。触球与进球分别列出。',
  },
};
export const chapters = [
  {
    label: '看见不足',
    version: 'V1',
    run: 'X1',
    title: '鸭到位了，球却走了',
    text: '从一段失败切片开始。猫读记录提出几个可能解释，先不把“没踢到”判成权重不行。',
  },
  {
    label: '选择改法',
    version: 'V2',
    run: 'X2',
    title: '先改更贴近失败的两处',
    text: '控制和摆位参数成套试改。用相同的眼睛、尺子和六个场景，看整套效果与代价。',
  },
  {
    label: '核对加载',
    version: 'V2',
    run: 'X3',
    title: '补测不是新版本，跑错也不能算',
    text: '计划加载 H2，模拟回执却是 H1。保留这次中止记录，成绩不计入 V2；先修加载再补测。',
  },
  {
    label: '换眼睛尺子',
    version: 'V3',
    run: 'X4',
    title: '多触球，不一定多进球',
    text: '从 V1 分出测量分支。先校验新判法，再采集 O2；X1 旧记录缺越线证据，保留旧判断并标记无法重判。',
  },
  {
    label: '合并重测',
    version: 'V4',
    run: 'X5',
    title: '同一把尺，再问改动值不值',
    text: '合并不是把两个分数相加。V4 与 V3 在 EV2 下重新对照，六例完整展示，右侧回归仍然可见。',
  },
  {
    label: '新场景验证',
    version: 'V4',
    run: 'X7',
    title: '跳出调过的六道题',
    text: '候选冻结后，首次使用另外八个左侧输入 D2；相同初态成对跑 V3/V4。这里只演示外推证据应怎么读。',
  },
  {
    label: '有限采用',
    version: 'V4',
    run: 'X7',
    title: '留下有把握的部分，继续看失败',
    text: '模拟预算接受最多 30% 的试跑开销增加，本次是 25%。只在左侧试用 V4；右侧沿用 V3，完整足球协作仍没有结论。',
  },
] as const;
export function comparable(a: DemoRun, b: DemoRun): boolean {
  return (
    a.loaded &&
    b.loaded &&
    a.evaluation === b.evaluation &&
    a.sampleSet === b.sampleSet &&
    a.observation === b.observation
  );
}
export function score(values: boolean[] | null): string {
  return values ? `${values.filter(Boolean).length}/${values.length}` : '未知';
}
export function comparisonRun(run: DemoRun): DemoRun | undefined {
  const id = ({ X2: 'X1', X5: 'X4', X7: 'X6' } as Record<string, string>)[run.id];
  return demoRuns.find((candidate) => candidate.id === id);
}
/** Synthetic event packet behind one rendered row; never claimed as a physical simulation. */
export function eventPacket(run: DemoRun, index: number) {
  if (!run.loaded) return { truth: 'mock', run: run.id, aborted: true, planned: 'H2', loaded: 'H1' };
  const contact = Boolean(run.contact?.[index]);
  const goal = Boolean(run.goals?.[index]);
  const foot = caseSets[run.sampleSet][index].startsWith('右') ? 'right' : 'left';
  return {
    truth: 'mock',
    run: run.id,
    case: caseSets[run.sampleSet][index],
    window: [0, 26],
    kickWindow: contact ? [10, 11] : null,
    designatedFoot: foot,
    contactEvent: contact ? { second: 10.4, foot } : null,
    crossing:
      run.observation === 'O1' ? 'not_observed' : goal ? { second: 12, wholeBall: true, insideGoal: true } : null,
    decision: {
      rubric: evaluations[run.evaluation as keyof typeof evaluations].rubric,
      contact,
      goal: run.goals ? goal : null,
    },
  };
}
