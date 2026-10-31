/** Design-only view data. None of these ids are owner refs or production Program state. */
export const SOLUTION_PREVIEW_ID = 'evolution-program:31103110311031103110311031103110';
export type SchemeId = 'S1' | 'S2' | 'S3';
export type Role = 'all' | 'changed' | 'observation' | 'rubric';
export interface Member {
  id: string;
  category: string;
  name: string;
  revision: string;
  detail: string;
  sourceField: string;
}
export interface Scheme {
  id: SchemeId;
  parent: SchemeId | null;
  title: string;
  change: string;
  why: string;
  conclusion: string;
  members: Member[];
}
const baseline: Member[] = [
  {
    id: 'model',
    category: 'Model',
    name: '鸭的行走与左右踢腿策略',
    revision: 'M1',
    detail: '本例保持权重；先判断动作触发与局部控制。',
    sourceField: 'plan.modelFiles / modelRepository / modelRevision',
  },
  {
    id: 'body',
    category: '执行配置',
    name: '身体执行与关节响应',
    revision: 'B1',
    detail: '动作缩放与执行器参数保持一致。',
    sourceField: 'plan.actionScale / environment.actuator',
  },
  {
    id: 'control',
    category: '硬 Harness',
    name: '接近、摆位与起脚控制',
    revision: 'H1',
    detail: '将球的位置转成接近路径和起脚时机。',
    sourceField: 'codeFiles / plan.approachController',
  },
  {
    id: 'config',
    category: '控制配置',
    name: '摆位容差与持续时间',
    revision: 'C1',
    detail: '与控制逻辑配套，不把参数改动自动算作独立贡献。',
    sourceField: 'plan.approachController',
  },
  {
    id: 'protocol',
    category: '硬 Harness',
    name: '猫指令的接收、拒收与执行',
    revision: 'P1',
    detail: '协议固定。未形成可独立版本化的猫战术资产，本例不假造软 Harness 版本。',
    sourceField: 'codeFiles: football/football_contract.py',
  },
  {
    id: 'environment',
    category: '环境',
    name: '共享球场与物理条件',
    revision: 'E1',
    detail: '仿真、地面、球与起始条件；不外推实物表现。',
    sourceField: 'environment / plan.sceneFiles',
  },
  {
    id: 'observation',
    category: '观测',
    name: '球位、动作与指定脚接触记录',
    revision: 'O1',
    detail: '记录触球，不含用于新规约的越线观测。',
    sourceField: 'episodes / plan.ballObservation',
  },
  {
    id: 'rubric',
    category: '规约',
    name: '指定脚触球的判定',
    revision: 'R1',
    detail: '触球不等于进球，更不等于协同形成。',
    sourceField: 'reference only: football/football_contract.py',
  },
  {
    id: 'data',
    category: 'Data',
    name: '公开的六个偏侧场景',
    revision: 'D1',
    detail: '用于开发判断；不是独立验证集。',
    sourceField: 'plan.cases',
  },
];
function members(changes: Record<string, Partial<Member>>): Member[] {
  return baseline.map((member) => ({ ...member, ...changes[member.id] }));
}
export const schemes: Scheme[] = [
  {
    id: 'S1',
    parent: null,
    title: '原方案',
    change: '作为本轮的比较基线。',
    why: '先保留已有身体策略、协议和场景，识别局部控制的限制。',
    conclusion: '示例：六个场景中四个触球；协同配合仍未验证。',
    members: baseline,
  },
  {
    id: 'S2',
    parent: 'S1',
    title: '配套改控制与摆位',
    change: '配套调整局部控制与摆位配置；模型、协议、环境和测量条件保持不变。',
    why: '未起脚可能来自摆位与触发的配合，先比较整套改动；权重能力不足仍是待排除的解释。',
    conclusion: '示例：多一个场景触球，但右侧出现回归、试跑成本增加。两项改动各自贡献未分离。',
    members: members({
      control: { revision: 'H2', detail: '设计假设：持续修正摆位，保留失败与未起脚片段。' },
      config: { revision: 'C2', detail: '设计假设：调整摆位容差与持续时间，与控制一并比较。' },
    }),
  },
  {
    id: 'S3',
    parent: 'S1',
    title: '回到原分支，改观测与规约',
    change: '保留原方案的控制，增加越线观测并调整判法；不继承控制分支的改动。',
    why: '仅看触球不能回答有效进球。先补越线记录与判法，不用换尺后的分数宣称控制改善。',
    conclusion: '尚未运行。缺少越线观测的旧记录，也不能按新规约硬重判。',
    members: members({
      observation: { revision: 'O2', detail: '设计假设：在接触之外增加整球越线观测。' },
      rubric: { revision: 'R2', detail: '设计假设：要求指定脚触球后整球越线；需先核验判法。' },
    }),
  },
];
export interface Experiment {
  id: string;
  scheme: SchemeId;
  roles: Record<string, string[]>;
  title: string;
  state: 'recorded' | 'mismatch' | 'unrun';
  summary: string;
  cases: boolean[] | null;
  cost: string;
}
const baseRoles = {
  model: ['被试中的固定成员'],
  body: ['执行条件'],
  control: ['被试'],
  config: ['被试'],
  protocol: ['协作边界'],
  environment: ['环境'],
  observation: ['observation'],
  rubric: ['rubric'],
  data: ['样本'],
};
export const experiments: Experiment[] = [
  {
    id: 'X1',
    scheme: 'S1',
    roles: baseRoles,
    title: '原方案的六场景试跑',
    state: 'recorded',
    summary: '示例结果：4 / 6 指定脚触球；仍有两个未触球场景。',
    cases: [true, false, false, true, true, true],
    cost: '8 分钟试跑；人工核查成本未记录',
  },
  {
    id: 'X2',
    scheme: 'S2',
    roles: baseRoles,
    title: '成套改动的同场景对照',
    state: 'recorded',
    summary: '示例结果：5 / 6 指定脚触球；右侧更宽从触球变为未触球。',
    cases: [true, true, true, true, true, false],
    cost: '10 分钟试跑；人工核查成本未记录',
  },
  {
    id: 'X3',
    scheme: 'S2',
    roles: baseRoles,
    title: '同版补测 · 加载核对未通过',
    state: 'mismatch',
    summary: '实际加载不符：计划 H2，回执仍是 H1；不能把结果归到 S2。',
    cases: null,
    cost: '2 分钟后中止；没有可归属 S2 的结果',
  },
  {
    id: 'X4',
    scheme: 'S3',
    roles: { ...baseRoles, observation: ['observation', '待验证的改动'], rubric: ['rubric', '待校准的判法'] },
    title: '新观测与规约下的试跑',
    state: 'unrun',
    summary: '尚未运行；没有实际加载、成绩或成本回执。',
    cases: null,
    cost: '未知（未运行）',
  },
];
export const caseNames = ['左侧较近', '左侧较远', '左侧更宽', '右侧较近', '右侧较远', '右侧更宽'];
export const schemeById = (id: SchemeId) => schemes.find((scheme) => scheme.id === id)!;
export function changedMembers(scheme: Scheme): string[] {
  if (!scheme.parent) return [];
  const parent = schemeById(scheme.parent);
  return scheme.members
    .filter((member) => parent.members.find((entry) => entry.id === member.id)?.revision !== member.revision)
    .map((member) => member.id);
}
