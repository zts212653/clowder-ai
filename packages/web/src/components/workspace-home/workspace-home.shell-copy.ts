/**
 * Every user-visible word on the new shell's Workspace home, in both languages (home-northstar README「界面用词表」; F322
 * AC-B6–B8). Nothing else in `workspace-home/` spells a user-visible string. The Chinese is what the home said before the
 * language round, word for word (exceptions: 托管命令 reads 命令, an internal word dropped; and the three Chinese lines
 * F323's owner ruled on, see below); the English follows the approved vocabulary table and the naming table
 * `naming-en-home-2026-10-03.md`. Six wordings in the F323 domain (`wait.reasonUnavailable`, `wait.reasonIncomplete`,
 * `wait.observed`, `wait.awaitingNewBoot`, `wait.satisfiedNewBoot`, `wait.satisfiable`) are that card's owner's, ruled in
 * §一·b of the naming table: they describe a candidate evaluated on an ASSUMED next boot and a read time of the local
 * origin/main, never "met" or "verified" — change them only with that owner.
 *
 * Names that belong to other owners stay as the code calls them today until their owners rename them together:
 * 「正在发生」(F295) and 「等待与接回」(F323).
 *
 * A sentence with a count, a name or a state is ONE template per language — never fragments joined in the page, because the
 * two languages order and punctuate them differently ("等待运行版本包含 X，API 就绪" / "Waiting for the running version to
 * include X, with API ready").
 */
import { defineShellCopy } from '@/components/shell/shell-copy';

export const homeCopy = defineShellCopy(
  {
    zh: {
      live: {
        title: '正在发生',
        scope: (count: number) => `所有对话 · ${count} 件在跑`,
        partialScope: (count: number) => `所有对话 · 已确认 ${count} 件在跑`,
        currentProject: '当前项目',
        uncategorized: '未分类',
        projectCount: (count: number) => `${count} 件`,
        projectRunning: (count: number, time: string) => `${count} 件在跑 · 最长 ${time}`,
        confirmedCount: (count: number) => (count > 0 ? `已确认 ${count} 件` : '待确认'),
        projectLabel: (name: string, count: number, collapsed: boolean) =>
          `${name}，${count} 件在跑，${collapsed ? '已收起' : '已展开'}`,
        projectUnavailable: '这个项目的运行情况暂时读不到',
        foldFailed: '项目分组偏好暂时无法同步，请重试。',
        here: '当前对话',
        replying: '回复中',
        waitingBackground: '等待后台完成',
        detail: '详情',
        openConversation: '打开对话',
        stop: '停止',
        liveRun: '实时运行',
        background: (label: string) => `后台任务 · ${label}`,
        loading: '正在同步所有对话的运行状态…',
        unverified: '当前无法验证运行状态，请稍后重试。',
        stale: '同步暂时失败，以上为最近一次已验证状态。',
      },
      // The design's name for each managed-command kind ("全量门禁" is an internal word: it reads 完整检查).
      activity: {
        full_gate: '完整检查',
        test: '测试',
        build: '构建',
        lint: '代码检查',
        check: '专项检查',
        command: '命令',
      },
      wait: {
        title: '等待与接回',
        scope: (count: number) => `所有对话 · ${count} 件`,
        updateShort: '等正式环境更新',
        projectCount: (count: number) => `${count} 件`,
        unknownShort: '条件待确认',
        readyShort: '可以接回',
        updateCount: (count: number) => `${count} 件在等正式环境更新`,
        longest: (duration: string) => `最久 ${duration}`,
        projectLabel: (name: string, count: number, collapsed: boolean) =>
          `${name}，${count} 件等待与接回，${collapsed ? '已收起' : '已展开'}`,
        empty: '暂无待跟进事项',
        emptyHint: '猫会在原任务里登记“版本就绪后接我回来”，这里会替你记住来源和下一步。',
        loading: '正在读取等待更新的事项…',
        error: '当前无法读取等待更新清单。',
        retry: '重试',
        stale: '同步暂时失败，以上为最近一次已验证清单。',
        openConversation: '打开对话',
        ownerUnknown: '待确认负责猫',
        waitUnknown: '等待时长未知',
        justRegistered: '刚刚登记',
        waited: (duration: string) => `已等待 ${duration}`,
        waitForFix: '等正式环境更新到包含这次修复',
        revisionUnconfirmed: '还没确认正式环境已包含',
        waitForBoot: '等正式环境重启并就绪',
        bootUnconfirmed: '还没确认正式环境已重启并就绪',
        readySummary: '条件已满足，可以接回',
        returnDetails: '接回后',
        readyDetails: '继续处理',
        resumeForecast: (count: number) => `main 上已有新版本，正式环境更新后这 ${count} 件会接回`,
        // F323's own condition (a revision included, or a new boot, with these services ready). Said as a target while the
        // row is waiting or unknown; said as done only when the canonical state is ready_to_return. One sentence each.
        awaitingRevision: (revision: string, services: string) => `等待运行版本包含 ${revision}，${services} 就绪`,
        awaitingNewBoot: (services: string) => `等待新启动，${services} 就绪`,
        satisfiedRevision: (revision: string, services: string) => `运行版本已包含 ${revision}，${services} 已就绪`,
        satisfiedNewBoot: (services: string) => `已出现新启动，${services} 已就绪`,
        afterReturn: (nextStep: string) => `接回后：${nextStep}`,
        canContinue: (nextStep: string) => `可以继续：${nextStep}`,
        nextStepFallback: '回原任务确认下一步',
        reasonUnavailable: '暂时读不到运行状态，这项等待先保留。',
        reasonIncomplete: '还没确认正式环境已满足这项等待',
        reasonRecheck: '检测到可能就绪，正在复核并安排原猫接回。',
        // A row the server could not classify and gave no reason for: the flat list has no 暂不能判定 heading to carry it.
        undetermined: '暂时无法判定条件是否已满足',
        candidate: (revision: string) => `候选 ${revision}`,
        observed: (age: string) => `截至 ${age}`,
        satisfiable: (count: number) => `预计满足 ${count} 项`,
        unknownEvidence: (count: number) => `另有 ${count} 项证据待确认`,
      },
      tools: {
        // Honest about what the search does today: file names and contents, plus the tool names on this page.
        searchPlaceholder: '搜索文件和工具…',
        groups: { code: '代码', activity: '活动', other: '其他' },
        changedFiles: (count: number) => `${count} 个文件`,
        noMatch: '没有找到匹配的内容',
        // Only places verified reachable in the new shell (headers, mailbox, settings), not the design's wishful sentence.
        signpost: '毛线球、作品在对话顶栏；审批和需要我处理在待办；成员、账户和配置在设置与管理。',
        // Two entries whose final homes are not wired yet (north-star §1.8, 10-03): each says where it belongs and, until
        // that is connected, opens from here. The link ends the sentence in both languages, so `tail` is the full stop.
        transitional: {
          allWork: {
            lead: '日程也可从待办打开；',
            link: '从这里打开',
            tail: '。',
            openLabel: '打开日程',
          },
        },
        // The words of the workspace-search dropdown under the field (the component has classic defaults; this overrides them).
        search: {
          fileNameTag: '文件名',
          contentTag: '内容',
          searching: '正在搜索当前工作区',
          unavailable: '当前没有可搜索的工作区；仍可在下面查找功能入口。',
          heading: '当前工作区',
          viewAll: (count: number) => `查看全部 ${count} 条`,
          failed: '暂时没能搜索当前工作区，请重试。',
          noResult: '没有找到文件名或正文匹配；下面仍会保留匹配的功能入口。',
          working: '正在搜索文件名和正文…',
        },
      },
      // Name and one-line description of each tool row. What a row opens is not here (home-rows.ts hands the host the same
      // destination object the classic launcher does); the words only.
      rows: {
        tasks: { label: '毛线球', description: '当前对话的毛线球与状态' },
        files: { label: '文件与代码', description: '按目录浏览项目文件' },
        changes: { label: '变更', description: '工作区里已修改的文件' },
        git: { label: 'Git', description: '分支、提交与仓库状态' },
        terminal: { label: '终端', description: '命令与输出记录' },
        browser: { label: '页面预览', description: '预览本地页面' },
        status: { label: '状态与会话', description: '成员状态与会话记录' },
        trajectory: { label: '轨迹', description: '每次运行的工具调用' },
        theater: { label: '回放', description: '从头回放当前对话' },
        recall: { label: '记忆', description: '当前对话用到的记忆' },
        voice: { label: '语音与会议', description: '语音转写、会议记录' },
        films: { label: '片子', description: '已有视频项目与制作' },
        team: { label: '猫猫团队', description: '成员能力与协作状态' },
        schedule: { label: '调度', description: '定时任务与下一次运行' },
        eval: { label: '评估', description: '周期评估、结论与台账' },
        community: { label: '社区', description: '社区事项与贡献记录' },
        'capability-evolution': { label: '能力进化', description: '正在改进的能力与项目' },
      },
      // "How long": a duration after 已等待, and "how long ago" after 观察于. English says the whole word and counts it.
      time: {
        justNow: '刚刚',
        minutesAgo: (n: number) => `${n} 分钟前`,
        hoursAgo: (n: number) => `${n} 小时前`,
        daysAgo: (n: number) => `${n} 天前`,
        minutes: (n: number) => `${n} 分钟`,
        hours: (n: number) => `${n} 小时`,
        days: (n: number) => `${n} 天`,
      },
    },
    en: {
      live: {
        title: 'Happening now',
        scope: (count: number) => `All conversations · ${count} running`,
        partialScope: (count: number) => `All conversations · ${count} confirmed running`,
        currentProject: 'Current project',
        uncategorized: 'Uncategorized',
        projectCount: (count: number) => `${count} running`,
        projectRunning: (count: number, time: string) => `${count} running · longest ${time}`,
        confirmedCount: (count: number) => (count > 0 ? `${count} confirmed` : 'Unverified'),
        projectLabel: (name: string, count: number, collapsed: boolean) =>
          `${name}, ${count} running, ${collapsed ? 'collapsed' : 'expanded'}`,
        projectUnavailable: "Can't read run status for this project right now",
        foldFailed: "Couldn't sync project display preferences. Try again.",
        here: 'Current conversation',
        replying: 'Replying',
        waitingBackground: 'Waiting on background work',
        detail: 'Details',
        openConversation: 'Open conversation',
        stop: 'Stop',
        liveRun: 'Live run',
        background: (label: string) => `Background task · ${label}`,
        loading: 'Syncing run status across conversations…',
        unverified: "Can't verify run status right now. Try again shortly.",
        stale: "Couldn't sync. Showing the last verified status.",
      },
      activity: {
        full_gate: 'Full check',
        test: 'Tests',
        build: 'Build',
        lint: 'Lint',
        check: 'Targeted check',
        command: 'Command',
      },
      wait: {
        title: 'Waiting to resume',
        scope: (count: number) => `All conversations · ${count} items`,
        updateShort: 'Waiting for live update',
        projectCount: (count: number) => `${count} ${count === 1 ? 'item' : 'items'}`,
        unknownShort: 'Condition unconfirmed',
        readyShort: 'Ready to resume',
        updateCount: (count: number) => `${count} waiting for live update`,
        longest: (duration: string) => `longest ${duration}`,
        projectLabel: (name: string, count: number, collapsed: boolean) =>
          `${name}, ${count} waiting items, ${collapsed ? 'collapsed' : 'expanded'}`,
        empty: 'Nothing waiting',
        emptyHint:
          'When a cat asks to resume once a new version is running, it shows up here with its source and next step.',
        loading: 'Loading waiting items…',
        error: "Can't load waiting items right now.",
        retry: 'Retry',
        stale: "Couldn't sync. Showing the last verified list.",
        openConversation: 'Open conversation',
        ownerUnknown: 'Owner not confirmed',
        waitUnknown: 'Wait time unknown',
        justRegistered: 'Just added',
        waited: (duration: string) => `Waiting for ${duration}`,
        waitForFix: 'Waiting for the live version to include this fix',
        revisionUnconfirmed: "Haven't confirmed the live version includes this fix",
        waitForBoot: 'Waiting for the live environment to restart and be ready',
        bootUnconfirmed: "Haven't confirmed the live environment has restarted and is ready",
        readySummary: 'Ready to resume',
        returnDetails: 'After resuming',
        readyDetails: 'Continue',
        resumeForecast: (count: number) =>
          `A newer version is on main; after the live update, ${count} ${count === 1 ? 'item will' : 'items will'} resume`,
        // One service keeps the naming table's sentence ("…and the API is ready"); several are a list, which takes no article.
        awaitingRevision: (revision: string, services: string) =>
          `Waiting until the running version includes ${revision} and ${services.includes('+') ? `${services} are` : `the ${services} is`} ready`,
        awaitingNewBoot: (services: string) => `Waiting for a restart and ${services} to be ready`,
        satisfiedRevision: (revision: string, services: string) =>
          `Running version includes ${revision}; ${services} ready`,
        satisfiedNewBoot: (services: string) => `Restarted; ${services} ready`,
        afterReturn: (nextStep: string) => `After resuming: ${nextStep}`,
        canContinue: (nextStep: string) => `Ready to resume: ${nextStep}`,
        nextStepFallback: 'Confirm the next step in the original task',
        reasonUnavailable: "Can't read run status right now; this item stays.",
        reasonIncomplete: "Haven't confirmed the live environment meets this condition",
        reasonRecheck: 'Looks ready; rechecking before the original cat resumes.',
        undetermined: "Can't tell yet whether the condition is met",
        candidate: (revision: string) => `Candidate ${revision}`,
        observed: (age: string) => `As of ${age}`,
        satisfiable: (count: number) =>
          count === 1 ? 'Expected to satisfy 1 item' : `Expected to satisfy ${count} items`,
        unknownEvidence: (count: number) => (count === 1 ? '1 more item to confirm' : `${count} more items to confirm`),
      },
      tools: {
        searchPlaceholder: 'Search files and tools…',
        groups: { code: 'Code', activity: 'Activity', other: 'Other' },
        changedFiles: (count: number) => (count === 1 ? '1 file' : `${count} files`),
        noMatch: 'No matches',
        signpost:
          'Tasks and works are in the conversation header; approvals and items needing you are in To-do; members, accounts and configuration are in Settings.',
        transitional: {
          allWork: {
            lead: 'Schedule is also in To-do; ',
            link: 'open it here',
            tail: '.',
            openLabel: 'Open Schedule',
          },
        },
        search: {
          fileNameTag: 'File name',
          contentTag: 'Text',
          searching: 'Searching this workspace',
          unavailable: 'No workspace to search. You can still find tools below.',
          heading: 'This workspace',
          viewAll: (count: number) => `View all ${count} results`,
          failed: "Couldn't search this workspace. Try again.",
          noResult: 'No files match. Matching tools are listed below.',
          working: 'Searching file names and text…',
        },
      },
      rows: {
        tasks: { label: 'Tasks', description: 'Tasks and their status in this conversation' },
        files: { label: 'Files & code', description: 'Browse project files by folder' },
        changes: { label: 'Changes', description: 'Files modified in the workspace' },
        git: { label: 'Git', description: 'Branches, commits and repository status' },
        terminal: { label: 'Terminal', description: 'Commands and their output' },
        browser: { label: 'Page preview', description: 'Preview local pages' },
        status: { label: 'Status & sessions', description: 'Member status and session history' },
        trajectory: { label: 'Trace', description: 'Tool calls in each run' },
        theater: { label: 'Replay', description: 'Replay the current conversation from the start' },
        recall: { label: 'Memory', description: 'Memories the cats used in this conversation' },
        voice: { label: 'Voice & meetings', description: 'Voice transcription and meeting notes' },
        films: { label: 'Films', description: 'Existing video projects and production' },
        team: { label: 'Cat team', description: 'Member capabilities and collaboration' },
        schedule: { label: 'Scheduling', description: 'Scheduled tasks and their next run' },
        eval: { label: 'Evaluations', description: 'Periodic checks, results and ledger' },
        community: { label: 'Community', description: 'Community work and contributions' },
        'capability-evolution': {
          label: 'Capability evolution',
          description: 'Capabilities and projects being improved',
        },
      },
      time: {
        justNow: 'just now',
        minutesAgo: (n: number) => (n === 1 ? '1 minute ago' : `${n} minutes ago`),
        hoursAgo: (n: number) => (n === 1 ? '1 hour ago' : `${n} hours ago`),
        daysAgo: (n: number) => (n === 1 ? '1 day ago' : `${n} days ago`),
        minutes: (n: number) => (n === 1 ? '1 minute' : `${n} minutes`),
        hours: (n: number) => (n === 1 ? '1 hour' : `${n} hours`),
        days: (n: number) => (n === 1 ? '1 day' : `${n} days`),
      },
    },
  },
  {
    samples: {
      'live.scope': [[1], [12]],
      'live.partialScope': [[0], [1], [12]],
      'live.projectCount': [[1], [12]],
      'live.projectRunning': [
        [1, '1:05'],
        [12, '23:40'],
      ],
      'live.confirmedCount': [[0], [1], [12]],
      'live.projectLabel': [
        ['cat-planet', 4, true],
        ['cat-cafe', 1, false],
      ],
      'live.background': [['Full check'], ['Tests']],
      'wait.scope': [[1], [7]],
      'wait.projectCount': [[1], [4]],
      'wait.updateCount': [[1], [14]],
      'wait.longest': [['1 minute'], ['23 hours']],
      'wait.projectLabel': [
        ['cat-planet', 4, true],
        ['cat-cafe', 1, false],
      ],
      'wait.waited': [['3 minutes'], ['1 day']],
      'wait.awaitingRevision': [
        ['aaaaaaaa', 'API'],
        ['bbbbbbbb', 'API + WEB'],
      ],
      'wait.awaitingNewBoot': [['API'], ['API + WEB']],
      'wait.satisfiedRevision': [
        ['aaaaaaaa', 'API'],
        ['bbbbbbbb', 'API + WEB'],
      ],
      'wait.satisfiedNewBoot': [['API'], ['API + WEB']],
      'wait.afterReturn': [['verify it'], ['check the page']],
      'wait.canContinue': [['verify it'], ['check the page']],
      'wait.candidate': [['aaaaaaaa'], ['bbbbbbbb']],
      'wait.observed': [['just now'], ['4 minutes ago']],
      'wait.satisfiable': [[1], [3]],
      'wait.resumeForecast': [[0], [1], [3]],
      'wait.unknownEvidence': [[1], [3]],
      'tools.changedFiles': [[1], [2], [12]],
      'tools.search.viewAll': [[9], [40]],
      'time.minutesAgo': [[1], [30]],
      'time.hoursAgo': [[1], [5]],
      'time.daysAgo': [[1], [3]],
      'time.minutes': [[1], [34]],
      'time.hours': [[1], [5]],
      'time.days': [[1], [3]],
    },
  },
);

/** The words of the home in one language, as `useShellCopy(homeCopy)` hands them to a component. */
export type HomeCopy = (typeof homeCopy)['zh'];
