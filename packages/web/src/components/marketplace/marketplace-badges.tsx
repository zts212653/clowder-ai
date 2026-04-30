'use client';

import type { InstallMode, MarketplaceEcosystem, TrustLevel } from '@cat-cafe/shared';
import { HubIcon } from '../hub-icons';

const ECOSYSTEM_STYLES: Record<MarketplaceEcosystem, { bg: string; text: string; label: string }> = {
  claude: { bg: 'bg-conn-purple-bg', text: 'text-conn-purple-text border-conn-purple-ring', label: 'Claude' },
  codex: { bg: 'bg-conn-emerald-bg', text: 'text-conn-emerald-text border-conn-emerald-ring', label: 'Codex' },
  openclaw: { bg: 'bg-conn-red-bg', text: 'text-conn-red-text border-conn-red-ring', label: 'OpenClaw' },
  antigravity: {
    bg: 'bg-[var(--color-cafe-accent)]/10',
    text: 'text-[var(--color-cafe-accent)] border-[var(--color-cafe-accent)]/30',
    label: 'Antigravity',
  },
};

export function EcosystemBadge({ ecosystem }: { ecosystem: MarketplaceEcosystem }) {
  const s = ECOSYSTEM_STYLES[ecosystem];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${s.bg} ${s.text}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {s.label}
    </span>
  );
}

const TRUST_STYLES: Record<TrustLevel, { bg: string; text: string; label: string; iconName: string }> = {
  official: { bg: 'bg-conn-emerald-bg', text: 'text-conn-emerald-text', label: 'official', iconName: 'shield' },
  verified: { bg: 'bg-conn-emerald-bg', text: 'text-conn-emerald-text', label: 'verified', iconName: 'check' },
  community: {
    bg: 'bg-[var(--color-cafe-accent)]/10',
    text: 'text-[var(--color-cafe-accent)]',
    label: 'community',
    iconName: 'users',
  },
};

export function TrustBadge({ level }: { level: TrustLevel }) {
  const s = TRUST_STYLES[level];
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${s.bg} ${s.text}`}>
      <HubIcon name={s.iconName} className="h-3 w-3" />
      {s.label}
    </span>
  );
}

const MODE_STYLES: Record<InstallMode, { bg: string; text: string; label: string; iconName: string }> = {
  direct_mcp: { bg: 'bg-conn-emerald-bg', text: 'text-conn-emerald-text', label: '一键安装', iconName: 'zap' },
  delegated_cli: {
    bg: 'bg-[var(--color-cafe-accent)]/10',
    text: 'text-[var(--color-cafe-accent)]',
    label: 'CLI 安装',
    iconName: 'terminal',
  },
  manual_file: { bg: 'bg-conn-amber-bg', text: 'text-conn-amber-text', label: '手动配置', iconName: 'file-text' },
  manual_ui: { bg: 'bg-conn-amber-bg', text: 'text-conn-amber-text', label: '手动配置', iconName: 'file-text' },
};

export function InstallModeBadge({ mode }: { mode: InstallMode }) {
  const s = MODE_STYLES[mode];
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${s.bg} ${s.text}`}>
      <HubIcon name={s.iconName} className="h-3 w-3" />
      {s.label}
    </span>
  );
}
