/**
 * Every user-visible word on the new shell's 主题 page, in both languages (F322 AC-B6–B8; home-northstar README §1.15
 * 「界面语言」 and the naming table `naming-en-home-2026-10-03.md` §四).
 *
 * The Chinese is what the page said before the language entry, word for word, plus the three lines the accepted design adds
 * (the page title and its one-line scope, and the 界面语言 section). Where the design's template draws a different Chinese word
 * from the one the code has (the template shows 浅色 / 深色, the page shows the stored theme names Light / Dark) the code's word
 * is kept, as the design owner confirmed: they are stored names, not words of this page. The create button stays 新建主题 and
 * its English is `New theme`, so both languages say the same thing (the design owner's call, not the naming table's earlier
 * `New colors`). The words the table does not list (使用中, 编辑, 删除 and the accessible names built from them) were accepted
 * by the design owner.
 *
 * NOT migrated, on purpose: the colour tuner (`OklchTuner`) that 编辑 / 新建主题 open from this page. It is a developer-grade tool
 * shared with the classic theme menu, and classic's words must not change, so it stays Chinese in English mode. Everything the
 * page itself spells is in this file; the tuner is not.
 *
 * 界面语言 options are written in their OWN language whichever language the page is in (中文（简体） and English — the
 * names of the languages, constants in `ThemeSettingsPanel`, not words of this page), so a person who chose the wrong one
 * still finds their own line. What this file holds is what each language is CALLED in the language being read (`names`): a
 * line shows it beside its own name only when it differs, so a Chinese reader gets "English 英文", an English reader gets
 * "中文（简体） Chinese (Simplified)", and the line of the language you are reading carries nothing.
 *
 * Theme names are data: the stored names of the themes (Light, Dark, and what a person called their own) are shown as stored
 * and are not here. The one name the page itself makes, for a new custom theme, is `customName`.
 */
import { defineShellCopy } from '@/components/shell/shell-copy';

export const themeSettingsCopy = defineShellCopy(
  {
    zh: {
      title: '主题',
      scope: '界面版本、语言和配色保存在这个浏览器；回话显示跟随你的账号。',
      presentation: {
        heading: '界面版本',
        v2: { label: '新版界面', note: '窄栏、对话栏与顶栏按新版布局' },
        classic: { label: '经典界面', note: '原来的布局，数据和权限完全相同' },
      },
      language: {
        heading: '界面语言',
        note: '只换新版界面上的字。对话、文件和猫写的话保持原样；草稿、看到的位置和正在运行的工作都不受影响。经典界面不受此设置影响。',
        names: { chinese: '中文（简体）', english: '英文' },
      },
      colors: {
        heading: '配色',
        inUse: '使用中',
        edit: '编辑',
        remove: '删除',
        editLabel: (name: string) => `编辑 ${name}`,
        removeLabel: (name: string) => `删除 ${name}`,
        create: '新建主题',
        customName: (n: number) => `自定义 ${n}`,
      },
    },
    en: {
      title: 'Theme',
      scope: 'Interface version, language and colors are saved in this browser. Reply display follows your account.',
      presentation: {
        heading: 'Interface version',
        v2: { label: 'New interface', note: 'Narrow rail, conversation column and header use the new layout' },
        classic: { label: 'Classic interface', note: 'The original layout, with the same data and permissions' },
      },
      language: {
        heading: 'Language',
        note: 'Changes the words of the new interface only. Conversations, files and what cats write stay as they are; drafts, reading position and running work are not affected. This setting does not affect the classic interface.',
        names: { chinese: 'Chinese (Simplified)', english: 'English' },
      },
      colors: {
        heading: 'Colors',
        // Not in the naming table: confirm with the design owner.
        inUse: 'In use',
        edit: 'Edit',
        remove: 'Delete',
        editLabel: (name: string) => `Edit ${name}`,
        removeLabel: (name: string) => `Delete ${name}`,
        create: 'New theme',
        customName: (n: number) => `Custom ${n}`,
      },
    },
  },
  {
    samples: {
      'colors.editLabel': [['Dark'], ['自定义 1']],
      'colors.removeLabel': [['Dark'], ['自定义 1']],
      'colors.customName': [[1], [2]],
    },
  },
);
