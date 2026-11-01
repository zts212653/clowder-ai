import { defineShellCopy } from '@/components/shell/shell-copy';

export const workContentCopy = defineShellCopy(
  {
    zh: {
      preview: 'HTML 作品预览',
      back: '返回',
      version: (revision: number) => `第 ${revision} 版`,
      versions: '作品版本',
      versionOption: (revision: number, current: boolean) => `第 ${revision} 版 · ${current ? '当前' : '历史'}`,
      refresh: '刷新版本',
      loading: (revision: number) => `正在读取第 ${revision} 版…`,
      unavailable: (revision: number) => `找不到第 ${revision} 版，或你没有查看权限。`,
      failed: (revision: number) => `读取第 ${revision} 版失败，内容未能验证。`,
      retry: '重试',
    },
    en: {
      preview: 'HTML work preview',
      back: 'Back',
      version: (revision: number) => `Version ${revision}`,
      versions: 'Work version',
      versionOption: (revision: number, current: boolean) => `Version ${revision} · ${current ? 'Current' : 'History'}`,
      refresh: 'Refresh versions',
      loading: (revision: number) => `Loading version ${revision}…`,
      unavailable: (revision: number) => `Version ${revision} was not found, or you do not have access.`,
      failed: (revision: number) => `Could not verify the content of version ${revision}. Please retry.`,
      retry: 'Retry',
    },
  },
  {
    samples: {
      version: [[1], [2]],
      versionOption: [
        [1, false],
        [2, true],
      ],
      loading: [[1], [2]],
      unavailable: [[1], [2]],
      failed: [[1], [2]],
    },
  },
);
