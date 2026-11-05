import { defineShellCopy } from '../shell/shell-copy';

/** Task subjects and activeForm are source content; only the surrounding UI is translated. */
export const planBoardCopy = defineShellCopy({
  zh: {
    title: '猫猫祟祟',
    completed: '已完成',
    interrupted: '已中断',
    running: '运行中',
    inProgress: '进行中',
    pending: '待处理',
    continue: '继续',
    resume: '继续任务',
    resumeMessage: '确认继续上次任务？',
    confirm: '确认',
    cancel: '取消',
  },
  en: {
    title: 'Plans',
    completed: 'Completed',
    interrupted: 'Interrupted',
    running: 'Running',
    inProgress: 'In progress',
    pending: 'Pending',
    continue: 'Continue',
    resume: 'Resume task',
    resumeMessage: 'Resume the previous task?',
    confirm: 'Confirm',
    cancel: 'Cancel',
  },
});
