'use client';

import type { CSSProperties } from 'react';
import { HubIcon } from '../hub-icons';
import { SETTINGS_SECTIONS, type SettingsSection } from './settings-nav-config';

interface SettingsNavProps {
  activeSection: string;
  onSelect: (sectionId: string) => void;
  searchQuery?: string;
}

function NavItem({ section, active, onSelect }: { section: SettingsSection; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-active={active ? 'true' : 'false'}
      className={`flex w-full items-center gap-2 rounded-lg px-2.5 h-9 text-left transition-colors ${active ? 'bg-[var(--console-active-bg)] font-medium' : 'hover:bg-[var(--console-hover-bg)]'}`}
      style={
        active
          ? ({
              ['--console-active-bg' as string]: `color-mix(in srgb, ${section.color} 10%, var(--console-card-bg) 90%)`,
              color: section.color,
            } as CSSProperties)
          : undefined
      }
    >
      <span
        className="flex-shrink-0"
        style={active ? { color: section.color } : { color: 'var(--cafe-text-secondary)' }}
      >
        <HubIcon name={section.icon} className="h-4 w-4" />
      </span>
      <span className={`text-[13px] truncate ${active ? 'font-medium' : 'text-cafe-secondary'}`}>{section.label}</span>
    </button>
  );
}

const SECTION_KEYWORDS: Record<string, string> = {
  members: '猫猫 成员 名册 roster cat',
  accounts: '密钥 API key 账号 credentials',
  im: '飞书 钉钉 企微 telegram 微信 connector',
  skills: 'skill 技能 能力 marketplace',
  mcp: 'MCP tool 工具',
  plugins: '插件 集成 GitHub PR email calendar',
  voice: '语音 TTS STT whisper',
  rules: '规则 家规 提示词 system prompt SOP 协作 governance',
  system: '配置 环境 .env bubble A2A codex',
  notify: '推送 通知 push web',
  ops: '运维 监控 排行 记忆 健康 命令 救援 usage',
};

export function SettingsNav({ activeSection, onSelect, searchQuery }: SettingsNavProps) {
  const q = searchQuery?.toLowerCase().trim() ?? '';
  const filtered = q
    ? SETTINGS_SECTIONS.filter(
        (s) =>
          s.label.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          (SECTION_KEYWORDS[s.id] ?? '').toLowerCase().includes(q),
      )
    : SETTINGS_SECTIONS;

  return (
    <nav className="flex flex-col gap-0.5" aria-label="设置导航">
      {filtered.length === 0 && q ? (
        <p className="console-card-soft rounded-xl px-4 py-3 text-xs text-cafe-muted">没有匹配的设置分区</p>
      ) : (
        filtered.map((section) => (
          <NavItem
            key={section.id}
            section={section}
            active={section.id === activeSection}
            onSelect={() => onSelect(section.id)}
          />
        ))
      )}
    </nav>
  );
}
