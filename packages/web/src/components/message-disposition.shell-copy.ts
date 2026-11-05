import { defineShellCopy } from './shell/shell-copy';

export const messageDispositionCopy = defineShellCopy(
  {
    zh: {
      composer: {
        heading: '发送策略',
        label: { next_work: '排队等待', continue_current: '引导当前回复' },
        scope: { thread: '本 Thread', global: '全局默认' },
        note: { next_work: '等待目标空闲后开始新回复', continue_current: '可引导时进入当前回复，否则继续排队' },
        menuLabel: (mode: string) => `发送策略：${mode}`,
        menuNote: '选择本 Thread 或全局默认策略',
        syncing: '同步中…',
        back: '返回添加菜单',
        appliesTo: '偏好作用域',
        loadFailed: '偏好读取失败',
        saveFailed: '偏好保存失败',
        httpFailed: (status: number) => `偏好保存失败 (${status})`,
      },
      settings: {
        heading: '默认发送策略',
        note: '猫正在工作时，新消息默认排队等待，或引导当前回复。每条对话仍可在输入框的 + 菜单里单独选择。',
        nextLabel: '排队等待',
        nextNote: '等当前一轮结束后自然开始',
        continueLabel: '引导当前回复',
        continueNote: '支持引导且有可追加的回复时，进入当前回复；否则排队等待',
        loading: '正在读取默认发送策略…',
        loadFailed: '默认发送策略没读到。',
        saving: '正在保存…',
        saveFailed: '默认发送策略没有保存，请重试。',
        retry: '重试',
      },
    },
    en: {
      composer: {
        heading: 'Send mode',
        label: { next_work: 'Wait in queue', continue_current: 'Steer the current reply' },
        scope: { thread: 'This thread', global: 'Default for all' },
        note: {
          next_work: 'Start a new reply once the cat is free',
          continue_current: 'Join the current reply when possible; otherwise wait in the queue',
        },
        menuLabel: (mode: string) => `Send mode: ${mode}`,
        menuNote: 'Choose for this thread or as the default',
        syncing: 'Syncing…',
        back: 'Back to add menu',
        appliesTo: 'Applies to',
        loadFailed: 'Send mode preferences could not be loaded',
        saveFailed: 'Send mode preferences could not be saved',
        httpFailed: (status: number) => `Send mode preferences could not be saved (${status})`,
      },
      settings: {
        heading: 'Default send mode',
        note: 'While a cat is working, new messages either wait in queue or steer the current reply. Each conversation can still choose separately from the composer’s + menu.',
        nextLabel: 'Wait in queue',
        nextNote: 'Start naturally after the current work finishes',
        continueLabel: 'Steer the current reply',
        continueNote:
          'Join the current reply when guidance is supported and append is available; otherwise wait in the queue',
        loading: 'Loading the default send mode…',
        loadFailed: 'The default send mode could not be loaded.',
        saving: 'Saving…',
        saveFailed: 'The default send mode could not be saved. Try again.',
        retry: 'Try again',
      },
    },
  },
  {
    samples: {
      'composer.menuLabel': [['Wait in queue'], ['Steer the current reply']],
      'composer.httpFailed': [[404], [503]],
    },
  },
);
