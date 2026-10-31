import { defineShellCopy, useShellCopy } from '../shell/shell-copy';
import { useShellPresentation } from '../shell/shell-presentation';

export const settingsDetailCopy = defineShellCopy({
  zh: {
    members: { title: '成员与运行时', description: '管理成员、模型和接入方式，查看当前接活状态与派活偏好。' },
    profiles: { title: '能力画像来源', description: '查看成员能力的观察记录、依据与来源。' },
    voice: { title: '语音管理', description: '设置语音输入、声音和术语，查看语音服务状态。' },
    system: { title: '系统配置', description: '查看当前配置和默认行为。' },
  },
  en: {
    members: {
      title: 'Members & runtime',
      description: 'Manage members, models and connections. Check current availability and work preferences.',
    },
    profiles: {
      title: 'Capability sources',
      description: 'View observations, evidence and sources for member capabilities.',
    },
    voice: { title: 'Voice', description: 'Set up voice input, voices and terminology. Check voice service status.' },
    system: { title: 'System settings', description: 'View current configuration and default behavior.' },
  },
});
export function useSettingsDetailText() {
  const localized = useShellCopy(settingsDetailCopy);
  const copy = useShellPresentation() === 'v2' ? localized : settingsDetailCopy.zh;
  return (section: string) => (Object.hasOwn(copy, section) ? copy[section as keyof typeof copy] : undefined);
}
