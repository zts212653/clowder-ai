export interface SettingsSection {
  id: string;
  label: string;
  icon: string;
  color: string;
  description: string;
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'members',
    label: '成员管理',
    icon: 'users',
    color: 'var(--color-opus-primary)',
    description: '成员名册、默认协作对象与编排顺序。',
  },
  {
    id: 'accounts',
    label: '账户与密钥',
    icon: 'key',
    color: 'var(--color-opus-primary)',
    description: '模型账户、凭据和执行身份的归属关系。',
  },
  {
    id: 'im',
    label: 'IM 对接',
    icon: 'plug',
    color: 'var(--color-cafe-accent)',
    description: '飞书、钉钉、企微和外部消息入口。',
  },
  {
    id: 'skills',
    label: 'Skill 管理',
    icon: 'zap',
    color: 'var(--color-cafe-accent)',
    description: '技能市场、安装计划和本地能力预览。',
  },
  {
    id: 'mcp',
    label: 'MCP 管理',
    icon: 'box',
    color: 'var(--color-cafe-accent)',
    description: 'MCP 服务、工具目录和浏览器自动化依赖。',
  },
  {
    id: 'plugins',
    label: '插件/集成',
    icon: 'puzzle',
    color: 'var(--color-cafe-accent)',
    description: '插件状态、外部集成以及安装结果。',
  },
  {
    id: 'voice',
    label: '语音管理',
    icon: 'mic',
    color: 'var(--color-gemini-primary)',
    description: '语音输入输出、术语表和 TTS 服务状态。',
  },
  {
    id: 'system',
    label: '系统配置',
    icon: 'settings',
    color: 'var(--color-gemini-primary)',
    description: '环境选项、默认行为和运行时总开关。',
  },
  {
    id: 'rules',
    label: '规则与 SOP',
    icon: 'file-text',
    color: 'var(--color-gemini-primary)',
    description: '家规、协作 SOP 和模型提示词入口。',
  },
  {
    id: 'notify',
    label: '通知',
    icon: 'bell',
    color: 'var(--color-gemini-primary)',
    description: '推送订阅、提醒策略与设备联动。',
  },
  {
    id: 'ops',
    label: '运维监控',
    icon: 'activity',
    color: 'var(--color-gemini-primary)',
    description: '服务健康、命令工具和运行态观测。',
  },
];

export const DEFAULT_SECTION = 'members';
