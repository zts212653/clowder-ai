/**
 * The words of the new shell's 设置与管理 frame — the catalogue on the left and the pin toggle — in both languages (F322
 * AC-B6–B8; home-northstar README §1.15 and the naming table `naming-en-home-2026-10-03.md` §四).
 *
 * The Chinese is what the frame said before this round, word for word, except the two things the design owner changed when he
 * reviewed this slice: 功能看板 for the entry that read "Mission Hub" (the Chinese in the naming table), and the pin sentences,
 * which now say 窄栏 because a pin lands on the narrow rail (WorldRail), not on the sidebar. `entries` repeats the labels of
 * `settings-ia.ts` (the structure — ids, icons, groups, destinations — stays there, and the rail's pins read its `label`), and
 * `__tests__/settings-shell-copy.test.ts` fails if a label or an id drifts apart. The English is the approved table:
 * 「连接与扩展」 is Integrations because "Connections & extensions" wraps to two lines in the 232-wide catalogue; the pin
 * sentences are the design owner's (Pin "X" to the narrow rail).
 *
 * `back` is the row at the top of the catalogue that returns to the conversation Settings was opened from (README §1.15, DESIGN.md
 * 「导航」: the previous level's name, never a bare "Back"). The conversation's name is the user's own title and is passed in as
 * data; only the words around it are here (the naming table: 返回 {对话名} / Back to {conversation}).
 *
 * Second-level names and their accessible labels also follow this dictionary. The shared navigation metadata keeps its
 * Chinese labels for the classic interface; section ids and destinations remain its responsibility.
 */

import { defineShellCopy } from '@/components/shell/shell-copy';
import { accountsCopy } from '../accounts/accounts.shell-copy';
import { settingsDetailCopy } from './settings-detail.shell-copy';
import { SETTINGS_SECTIONS } from './settings-nav-config';

export const settingsShellCopy = defineShellCopy(
  {
    zh: {
      title: '设置与管理',
      navigation: '设置导航',
      teamWorkspace: '成员能力与路由状态',
      sections: Object.fromEntries(SETTINGS_SECTIONS.map(({ id, label }) => [id, label] as const)),
      sectionGroup: (label: string) => `${label}的分区`,
      entries: {
        you: '你',
        team: '猫猫团队',
        schedule: '调度',
        evolution: '能力进化',
        eval: '评估',
        connect: '连接与扩展',
        system: '系统',
        theme: '主题',
        community: '社区',
        starry: '猫猫星球',
        mission: '功能看板',
        signals: '信号',
      },
      pin: (label: string) => `固定「${label}」到窄栏`,
      unpin: (label: string) => `从窄栏取消固定「${label}」`,
      back: (conversation: string) => `返回 ${conversation}`,
    },
    en: {
      title: 'Settings',
      navigation: 'Settings navigation',
      teamWorkspace: 'Member capabilities & routing',
      sections: {
        members: settingsDetailCopy.en.members.title,
        profiles: settingsDetailCopy.en.profiles.title,
        accounts: accountsCopy.en.title,
        concierge: 'Cat Ball',
        marketplace: 'Capability marketplace',
        skills: 'Skills',
        mcp: 'MCP',
        plugins: 'Plugins',
        voice: settingsDetailCopy.en.voice.title,
        system: settingsDetailCopy.en.system.title,
        rules: 'Collaboration & rules',
        notify: 'Notifications',
        ops: 'Operations',
      },
      sectionGroup: (label: string) => `${label} sections`,
      entries: {
        you: 'You',
        team: 'Cat team',
        schedule: 'Scheduling',
        evolution: 'Capability evolution',
        eval: 'Evaluation',
        connect: 'Integrations',
        system: 'System',
        theme: 'Theme',
        community: 'Community',
        starry: 'Cat Planet',
        mission: 'Mission Hub',
        signals: 'Signals',
      },
      pin: (label: string) => `Pin "${label}" to the narrow rail`,
      unpin: (label: string) => `Unpin "${label}" from the narrow rail`,
      back: (conversation: string) => `Back to ${conversation}`,
    },
  },
  {
    samples: {
      pin: [['Theme'], ['成员与运行时']],
      unpin: [['Theme'], ['成员与运行时']],
      back: [['F322 Workspace'], ['一个很长很长的对话标题']],
      sectionGroup: [['Cat team'], ['Integrations']],
    },
  },
);
