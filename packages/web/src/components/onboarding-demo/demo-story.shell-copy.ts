import { defineShellCopy } from '../shell/shell-copy';

export const demoStoryCopy = defineShellCopy({
  zh: {
    team: {
      architect: {
        name: '布偶猫',
        role: '架构师 · 负责交付',
      },
      designer: {
        name: '暹罗猫',
        role: '设计师 · 负责体验',
      },
      developer: {
        name: '缅因猫',
        role: '开发者 · 负责实现',
      },
    },
    events: {
      team: {
        title: '演示团队已就位',
        text: '已为这次演示准备三位伙伴。这里使用预置数据，不会检测本机工具，也不会调用模型。',
      },
      task: {
        title: '发布一个小目标',
        text: '@布偶猫 帮我做一个简单的“今天待办”网页。清楚、好看，能添加和完成任务。请和伙伴一起做好，最后给我一个能打开使用的页面。',
      },
      accept: {
        title: '接单与拆解',
        text: '收到，我负责最终交付。先确定体验，再实现，最后由我审查。@暹罗猫 请设计任务列表、添加入口和完成状态，做好后交回给我。',
      },
      design: {
        title: '设计方案已交回',
        text: '用一张清爽的每日清单：上方添加，下方勾选；保留“全部 / 未完成 / 已完成”筛选。列表为空时也要解释当前状态。@布偶猫 请整合方案。',
      },
      architecture: {
        title: '整合方案，交给开发',
        text: '采纳这个设计。用一个无需登录的网页实现，每项任务使用独立 ID，添加时去掉首尾空格。@缅因猫 请实现添加、完成和筛选，交回后我来检查。',
      },
      build: {
        title: '第一版实现已交回',
        text: '第一版已完成：可以添加、勾选和筛选任务。@布偶猫 请检查交互和边界情况。',
      },
      review: {
        title: '审查发现两个问题',
        text: '主要流程可用，但未完成任务全部勾选后变成空白；提交空格也没有反馈。@缅因猫 请补上“今天的任务都完成了”和“先写下一件小事”的提示。',
      },
      revision: {
        title: '已修正，交回复核',
        text: '已修正：完成所有任务时显示鼓励提示，空白输入会提示补充内容。保留用户当前的筛选条件。@布偶猫 请复核这两个场景。',
      },
      approved: {
        title: '审查通过，交付成果',
        text: '审查通过，两个问题都已修正。右侧的“今天待办”就是我们一起完成的成果，你可以亲自添加任务、勾选完成和切换筛选。接下来，创建你自己的猫猫团队吧。',
      },
    },
  },
  en: {
    team: {
      architect: {
        name: 'Ragdoll',
        role: 'Architect · Owns delivery',
      },
      designer: {
        name: 'Siamese',
        role: 'Designer · Owns the experience',
      },
      developer: {
        name: 'Maine Coon',
        role: 'Developer · Owns implementation',
      },
    },
    events: {
      team: {
        title: 'Demo team ready',
        text: 'Three teammates are ready for this demo. It uses preset data, without detecting local tools or calling a model.',
      },
      task: {
        title: 'Share a small goal',
        text: '@Ragdoll Help me build a simple “Today’s tasks” web page. Make it clear and pleasant, with tasks I can add and complete. Work with your teammates and give me a page I can open and use.',
      },
      accept: {
        title: 'Accept and divide the work',
        text: 'Got it. I’ll own the final delivery. We’ll design the experience, build it, then I’ll review it. @Siamese Please design the task list, add control and completion states, then hand it back to me.',
      },
      design: {
        title: 'Design handed back',
        text: 'Use a clean daily checklist: add at the top, check tasks below, and keep All / Open / Done filters. Explain the state when a list is empty, too. @Ragdoll Please bring the plan together.',
      },
      architecture: {
        title: 'Plan ready for development',
        text: 'Let’s use that design. Build a page with no login, give each task its own ID, and trim spaces when adding. @Maine Coon Please implement adding, completing and filtering. Hand it back for my review.',
      },
      build: {
        title: 'First version handed back',
        text: 'The first version is ready: you can add, check and filter tasks. @Ragdoll Please review the interactions and edge cases.',
      },
      review: {
        title: 'Review finds two issues',
        text: 'The main flow works, but completing every open task leaves a blank list, and entering only spaces gives no feedback. @Maine Coon Please add “All done for today” and “Write a small task first” messages.',
      },
      revision: {
        title: 'Revised and ready for another look',
        text: 'Fixed: finishing all tasks shows encouragement, and a blank entry asks for content. The current filter stays selected. @Ragdoll Please check both cases.',
      },
      approved: {
        title: 'Review passed, result delivered',
        text: 'Review passed. Both issues are fixed. Today’s tasks on the right is our shared result: try adding a task, marking it done and switching filters. Next, create your own team of cats.',
      },
    },
  },
});
