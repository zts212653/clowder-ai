export const WORKSPACE_MODES = [
  'dev',
  'recall',
  'schedule',
  'tasks',
  'community',
  'artifacts',
  'approval',
  'trajectory',
  'eval',
] as const;

export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export type WorkspaceModeGroup = 'work' | 'knowledge' | 'governance';

export interface WorkspaceModeMeta {
  label: string;
  description: string;
  group: WorkspaceModeGroup;
  searchTerms: string;
}

/**
 * Canonical display metadata for the Workspace launcher.
 *
 * Runtime identity remains WORKSPACE_MODES; consumers must iterate that tuple
 * instead of maintaining a second list of mode ids.
 */
export const WORKSPACE_MODE_META: Record<WorkspaceMode, WorkspaceModeMeta> = {
  dev: {
    label: '开发',
    description: '文件、变更、Git、终端与预览',
    group: 'work',
    searchTerms: 'files changes git terminal browser code 文件 变更 终端 浏览器',
  },
  recall: {
    label: '记忆',
    description: '记忆流、事件与账本',
    group: 'knowledge',
    searchTerms: 'memory recall ledger feed 记忆 账本',
  },
  schedule: {
    label: '调度',
    description: '定时任务与后台运行',
    group: 'work',
    searchTerms: 'schedule cron timer 调度 定时',
  },
  tasks: {
    label: '任务',
    description: '毛线球与执行进度',
    group: 'work',
    searchTerms: 'task plan backlog 毛线球 任务 计划',
  },
  community: {
    label: '社区',
    description: '开源协作与外部反馈',
    group: 'knowledge',
    searchTerms: 'community github issue pull request 社区 开源',
  },
  artifacts: {
    label: '产物',
    description: '当前 thread 的共享交付物',
    group: 'knowledge',
    searchTerms: 'artifact output deliverable 产物 文件',
  },
  approval: {
    label: '审批',
    description: '等待你判断或授权的事项',
    group: 'governance',
    searchTerms: 'approval authorization review 审批 授权',
  },
  trajectory: {
    label: '轨迹',
    description: '逐轮查看猫猫 invocation 与工具现场',
    group: 'governance',
    searchTerms: 'trajectory invocation session tools raw 轨迹 会话 工具 异常',
  },
  eval: {
    label: '评估',
    description: '证据、结论与待关注项',
    group: 'governance',
    searchTerms: 'eval evidence verdict a2a 评估 证据 结论',
  },
};

export function isWorkspaceMode(value: unknown): value is WorkspaceMode {
  return typeof value === 'string' && (WORKSPACE_MODES as readonly string[]).includes(value);
}
