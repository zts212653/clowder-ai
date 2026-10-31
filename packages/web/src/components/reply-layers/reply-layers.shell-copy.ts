import { defineShellCopy } from '../shell/shell-copy';

/**
 * F322 B — §1.16「一条回话分三层」, every word under the nameplate of a cat's reply in the new shell, in both languages
 * (home-northstar README §1.16「界面用词」). Tool names, commands, paths and model names are content, not copy, and are never
 * spelled here.
 */
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function clockParts(ms: number) {
  const total = Math.max(1, Math.round(ms / SECOND));
  return { hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60), seconds: total % 60 };
}

export const replyLayersCopy = defineShellCopy(
  {
    zh: {
      status: {
        compact: {
          run: '运行',
          edit: '改',
          read: '读',
          search: '搜',
          web: '网页',
          memory: '记忆',
          subagents: '子代理',
          other: '调用',
        },
        writing: '正在写回复',
        run: '正在运行命令',
        edit: '正在改文件',
        read: '正在读文件',
        search: '正在搜索',
        web: '正在查网页',
        memory: '正在查记忆',
        subagents: '正在等子代理',
        calling: (tool: string) => `正在调用 ${tool}`,
        quiet: (minutes: number) => `${minutes} 分钟没有动静`,
        quietUnknown: '没有动静',
        unverified: '状态暂不可核对',
        failed: '没有完成',
        failedBecause: (reason: string) => `没有完成：${reason}`,
        stopped: '已停止',
        rerouted: '上游换模',
      },
      failure: {
        response_timeout: '等待回复超时',
        stall_timeout: '长时间没有动静后结束',
        silent_completion: '结束了但没有输出',
      },
      record: {
        recall: (count: number) => `召回 ${count}`,
        recallUnavailable: '召回记录没读到',
        recallBreakdown: (search: number, graph: number, delivery: number) =>
          [search && `检索 ${search}`, graph && `关系查询 ${graph}`, delivery && `递送 ${delivery}`]
            .filter(Boolean)
            .join(' · '),
        process: (count: number) => `过程 ${count} 段`,
        toolCalls: (count: number) => `${count} 次工具调用`,
        errors: (count: number) => `其中 ${count} 次出错`,
        runningDuration: (ms: number): string => {
          const { hours, minutes, seconds } = clockParts(ms);
          return hours > 0
            ? `${hours} 小时 ${minutes} 分 ${seconds} 秒`
            : minutes > 0
              ? `${minutes} 分 ${seconds} 秒`
              : `${seconds} 秒`;
        },
        duration: (ms: number): string => {
          const { hours, minutes, seconds } = clockParts(ms);
          if (hours > 0) return `${hours} 小时 ${minutes} 分`;
          return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
        },
        title: '执行记录',
        trajectory: '轨迹',
        openTrajectory: '打开这一轮的轨迹',
        toggle: (open: boolean): string => (open ? '收起执行记录' : '展开执行记录'),
        thinking: '思考',
      },
      handoff: {
        handoff: '交给',
        queued: '排队交给',
        parallel: '同时交给',
      },
      // 合同四: the two switches that only decide whether a reply's record starts open. Default = the personal setting; the
      // other is this conversation's, in Workspace 状态与会话.
      settings: {
        activity: '执行记录',
        activityDefault: '执行记录默认',
        expanded: '展开',
        collapsed: '收起',
        followDefault: '跟随默认',
        followingExpanded: '跟随默认（当前展开）',
        followingCollapsed: '跟随默认（当前收起）',
        restoring: '恢复中…',
      },
    },
    en: {
      status: {
        compact: {
          run: 'Run',
          edit: 'Edit',
          read: 'Read',
          search: 'Find',
          web: 'Web',
          memory: 'Recall',
          subagents: 'Agents',
          other: 'Call',
        },
        writing: 'Writing a reply',
        run: 'Running a command',
        edit: 'Editing files',
        read: 'Reading files',
        search: 'Searching',
        web: 'Browsing the web',
        memory: 'Searching memory',
        subagents: 'Waiting for subagents',
        calling: (tool: string) => `Calling ${tool}`,
        quiet: (minutes: number) => `No activity for ${minutes} min`,
        quietUnknown: 'No activity',
        unverified: "Status can't be checked",
        failed: "Didn't finish",
        failedBecause: (reason: string) => `Didn't finish: ${reason}`,
        stopped: 'Stopped',
        rerouted: 'Model rerouted',
      },
      failure: {
        response_timeout: 'timed out waiting for a reply',
        stall_timeout: 'ended after a long silence',
        silent_completion: 'ended with no output',
      },
      record: {
        recall: (count: number) => `Recall ${count}`,
        recallUnavailable: "Recall records couldn't be read",
        recallBreakdown: (search: number, graph: number, delivery: number) =>
          [
            search && `${search} ${search === 1 ? 'search' : 'searches'}`,
            graph && `${graph} graph ${graph === 1 ? 'lookup' : 'lookups'}`,
            delivery && `${delivery} ${delivery === 1 ? 'delivery' : 'deliveries'}`,
          ]
            .filter(Boolean)
            .join(' · '),
        process: (count: number) => (count === 1 ? '1 process segment' : `${count} process segments`),
        toolCalls: (count: number) => (count === 1 ? '1 tool call' : `${count} tool calls`),
        errors: (count: number) => `${count} failed`,
        runningDuration: (ms: number): string => {
          const { hours, minutes, seconds } = clockParts(ms);
          return hours > 0
            ? `${hours}h ${minutes}m ${seconds}s`
            : minutes > 0
              ? `${minutes}m ${seconds}s`
              : `${seconds}s`;
        },
        duration: (ms: number): string => {
          const { hours, minutes, seconds } = clockParts(ms);
          if (hours > 0) return `${hours}h ${minutes}m`;
          return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
        },
        title: 'Activity',
        trajectory: 'Trajectory',
        openTrajectory: 'Open the trajectory of this turn',
        toggle: (open: boolean): string => (open ? 'Hide activity record' : 'Show activity record'),
        thinking: 'Thinking',
      },
      handoff: {
        handoff: 'Handed to',
        queued: 'Queued for',
        parallel: 'Handed to',
      },
      settings: {
        activity: 'Activity',
        activityDefault: 'Activity default',
        expanded: 'Expanded',
        collapsed: 'Collapsed',
        followDefault: 'Use default',
        followingExpanded: 'Use default (currently expanded)',
        followingCollapsed: 'Use default (currently collapsed)',
        restoring: 'Restoring…',
      },
    },
  },
  {
    samples: {
      'status.calling': [['pnpm'], ['get_design_context']],
      'status.quiet': [[1], [3], [12]],
      'status.failedBecause': [['x'], ['timed out']],
      'record.toolCalls': [[1], [2], [9]],
      'record.process': [[1], [2], [9]],
      'record.recall': [[1], [3], [14]],
      'record.recallBreakdown': [
        [1, 0, 0],
        [2, 1, 3],
      ],
      'record.errors': [[1], [3]],
      'record.runningDuration': [[HOUR + 2 * MINUTE + 13 * SECOND], [6 * MINUTE + 42 * SECOND], [11 * SECOND]],
      'record.duration': [[HOUR + 2 * MINUTE], [6 * MINUTE + 42 * SECOND], [11 * SECOND], [90 * MINUTE]],
      'record.toggle': [[true], [false]],
    },
    // An open/closed flag only picks the verb; the English and the Chinese both print neither value.
    grammar: { 'record.toggle': ['0'] },
  },
);
