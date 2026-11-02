import { useCollectiveLanguage } from './collective-copy.js';

const copy = {
  sort: ['待分拣', 'To sort'],
  add: ['分享材料…', 'Share material…'],
  refresh: ['刷新', 'Refresh'],
  loading: ['正在核对原来源…', 'Checking original sources…'],
  failed: ['暂时无法核对来源，请刷新重试。', 'Sources could not be checked. Refresh to retry.'],
  empty: ['还没有待分拣材料。', 'No material waiting to be sorted.'],
  wait: ['由项目负责人分拣', 'The project owner sorts this material'],
  create: ['建成任务', 'Create task'],
  merge: ['并进已有任务', 'Link to existing task'],
  reference: ['留作资料', 'Keep as reference'],
  ignore: ['忽略', 'Ignore'],
  unused: ['这句不用', 'Skip this passage'],
  unavailable: ['原来的来源现在打不开', 'The original source cannot be opened now'],
  remove: ['移出待分拣', 'Remove from triage'],
  revised: ['来源更新过，已建任务保留原来的内容', 'Source updated; created tasks keep their confirmed content'],
  revisions: ['查看修订记录', 'View revision history'],
  source: ['打开原出处', 'Open original source'],
  channel: ['频道出处', 'Channel publication'],
  passages: ['纪要原文片段 · 逐条处理', 'Meeting source passages · sort each separately'],
  readonly: [
    '分拣只改变项目，不会向外留言、改标签或定日期。',
    'Sorting changes this project. It sends no comments, changes no labels and sets no dates.',
  ],
  same: ['从多个地方到达 · 只列一次', 'Shared in several places · listed once'],
  handled: ['已处理', 'Processed'],
  owner: ['项目负责人', 'Project owner'],
  cancel: ['取消', 'Cancel'],
  save: ['确认', 'Confirm'],
  name: ['任务名', 'Task title'],
  outcome: ['完成标准', 'Completion criteria'],
  search: ['搜索已有任务', 'Search existing tasks'],
  unassigned: [
    '负责人：未分配 · 执行：先不定 · 截止：不设',
    'Owner: unassigned · Executor: undecided · Deadline: none',
  ],
  sourceLocked: ['来源已锁定在这份材料上', 'Source is bound to this material'],
  hint: ['材料提到的日子不会自动变成截止', 'Dates mentioned in material do not become deadlines'],
  cafe: ['从我家读取', 'Read from my Café'],
  noCafe: ['先连接自己的 Café，再分享已授权的来源。', 'Connect your own Café before sharing an authorized source.'],
  provider: ['来源', 'Source'],
  github: ['GitHub PR / Issue 链接', 'GitHub PR / Issue URL'],
  meeting: ['我的会议记录来源引用', 'Source reference from my meeting records'],
  consent: [
    '明确分享到这个项目所在的频道，成员可按原来源权限读取。',
    'Share explicitly in this project’s Channel. Members can read while the original source remains authorized.',
  ],
  share: ['分享并进入待分拣', 'Share to triage'],
  shareError: [
    '未能分享。检查来源授权与已安装的来源插件，再重试。',
    'Sharing failed. Check source authorization and the installed source plugin, then retry.',
  ],
  commandError: [
    '这项操作尚未确认，请刷新后查看最新去向。',
    'This action is not confirmed. Refresh to see its current destination.',
  ],
  references: ['项目资料', 'Project references'],
  taskSources: ['材料来源', 'Source material'],
  guess: ['猫的猜测', 'Cat suggestion'],
} as const;
export function useMaterialText() {
  const language = useCollectiveLanguage();
  return (key: keyof typeof copy) => copy[key][language === 'en' ? 1 : 0];
}
