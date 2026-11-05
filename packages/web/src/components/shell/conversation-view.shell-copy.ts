import { defineShellCopy } from './shell-copy';

export const conversationViewCopy = defineShellCopy(
  {
    zh: {
      group: '群聊',
      noEarlierMessages: '没有更多消息了',
      menuLabel: '切换对话视图',
      currentView: '当前视图',
      loading: '正在恢复视图…',
      loadFailed: '视图暂未恢复，当前显示群聊',
      saveFailed: '保存失败，请重试',
      readUnavailable: '读取记录暂不可用',
      working: '正在工作',
      sentAndSaid: '发给它的和它说的',
      noRecordedActivity: '还没有可确认的对话记录',
      unconfirmedRead: '未确认读到',
      readConfirmed: (time: string) => `确认读到 · ${time}`,
      executionStarted: (time: string) => `本次回复开始 · ${time}`,
    },
    en: {
      group: 'Group chat',
      noEarlierMessages: 'No earlier messages',
      menuLabel: 'Switch conversation view',
      currentView: 'Current view',
      loading: 'Restoring view…',
      loadFailed: 'The view could not be restored; showing Group chat',
      saveFailed: 'Could not save. Try again',
      readUnavailable: 'Read records temporarily unavailable',
      working: 'Working',
      sentAndSaid: 'Messages sent to this cat and what it said',
      noRecordedActivity: 'No confirmed conversation activity yet',
      unconfirmedRead: 'Read not confirmed',
      readConfirmed: (time: string) => `Read confirmed · ${time}`,
      executionStarted: (time: string) => `Response started · ${time}`,
    },
  },
  {
    samples: {
      readConfirmed: [['05:10'], ['19:42']],
      executionStarted: [['05:10'], ['19:42']],
    },
  },
);
