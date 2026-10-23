import { defineShellCopy } from './shell/shell-copy';

export const messageDispositionCopy = defineShellCopy(
  {
    zh: {
      composer: {
        heading: '这条发出去后',
        label: { next_work: '作为下一件工作', continue_current: '接着当前工作' },
        once: '仅这一次',
        note: { next_work: '等猫空闲后开始', continue_current: '能接进当前回复时补进去，否则继续排队' },
        menuLabel: (mode: string) => `这条发出去后：${mode}`,
        menuNote: '只影响这条消息',
        back: '返回添加菜单',
        loadFailed: '偏好读取失败',
        saveFailed: '偏好保存失败',
        httpFailed: (status: number) => `偏好保存失败 (${status})`,
      },
      settings: {
        heading: '默认发送方式',
        note: '猫正在工作时，新消息默认排到下一件工作，或接着当前工作。每条消息仍可在输入框的 + 菜单里单独选（仅这一次）。',
        nextLabel: '下一件工作',
        nextNote: '等当前一轮结束后自然开始',
        continueLabel: '接着当前工作',
        continueNote: '支持引导且有可追加的回复时，进入当前回复；否则排队等待',
        loading: '正在读取默认发送方式…',
        loadFailed: '默认发送方式没读到。',
        saving: '正在保存…',
        saveFailed: '默认发送方式没有保存，请重试。',
        retry: '重试',
      },
    },
    en: {
      composer: {
        heading: 'After sending',
        label: { next_work: 'As the next work', continue_current: 'Continue current work' },
        once: 'This message only',
        note: {
          next_work: 'Starts once the cat is free',
          continue_current: 'Joins the current reply when it can; otherwise waits in the queue',
        },
        menuLabel: (mode: string) => `After sending: ${mode}`,
        menuNote: 'Only affects this message',
        back: 'Back to add menu',
        loadFailed: 'Send mode preferences could not be loaded',
        saveFailed: 'Send mode preferences could not be saved',
        httpFailed: (status: number) => `Send mode preferences could not be saved (${status})`,
      },
      settings: {
        heading: 'Default send mode',
        note: 'While a cat is working, new messages either wait as the next work or continue the current work. Each message can still choose separately from the composer’s + menu.',
        nextLabel: 'Next work',
        nextNote: 'Start naturally after the current work finishes',
        continueLabel: 'Continue current work',
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
      'composer.menuLabel': [['As the next work'], ['Continue current work']],
      'composer.httpFailed': [[404], [503]],
    },
  },
);
