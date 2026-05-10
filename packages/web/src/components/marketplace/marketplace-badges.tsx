'use client';

import type { InstallMode, MarketplaceEcosystem, TrustLevel } from '@cat-cafe/shared';
import { HubIcon } from '../hub-icons';

const ECOSYSTEM_STYLES: Record<MarketplaceEcosystem, { bg: string; text: string; label: string }> = {
  claude: { bg: 'bg-opus-bg/60', text: 'text-opus-primary border-opus-light/40', label: 'Claude' },
  codex: { bg: 'bg-codex-bg/60', text: 'text-codex-primary border-codex-light/40', label: 'Codex' },
  openclaw: {
    bg: 'bg-[var(--semantic-error-bg)]',
    text: 'text-[var(--semantic-error-text)] border-[var(--semantic-error-text)]/20',
    label: 'OpenClaw',
  },
  antigravity: { bg: 'bg-gemini-bg/60', text: 'text-gemini-primary border-gemini-light/40', label: 'Antigravity' },
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
  official: {
    bg: 'bg-[var(--semantic-success-bg)]',
    text: 'text-[var(--semantic-success-text)]',
    label: 'official',
    iconName: 'shield',
  },
  verified: {
    bg: 'bg-[var(--semantic-success-bg)]',
    text: 'text-[var(--semantic-success-text)]',
    label: 'verified',
    iconName: 'check',
  },
  community: {
    bg: 'bg-[var(--semantic-info-bg)]',
    text: 'text-[var(--semantic-info-text)]',
    label: 'community',
    iconName: 'users',
  },
};

export function TrustBadge({ level }: { level: TrustLevel }) {
  const s = TRUST_STYLES[level];
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-caption font-medium ${s.bg} ${s.text}`}>
      <HubIcon name={s.iconName} className="h-3 w-3" />
      {s.label}
    </span>
  );
}

const MODE_STYLES: Record<InstallMode, { bg: string; text: string; label: string; iconName: string }> = {
  direct_mcp: {
    bg: 'bg-[var(--semantic-success-bg)]',
    text: 'text-[var(--semantic-success-text)]',
    label: '一键安装',
    iconName: 'zap',
  },
  delegated_cli: {
    bg: 'bg-[var(--semantic-info-bg)]',
    text: 'text-[var(--semantic-info-text)]',
    label: 'CLI 安装',
    iconName: 'terminal',
  },
  manual_file: {
    bg: 'bg-[var(--semantic-warning-bg)]',
    text: 'text-[var(--semantic-warning-text)]',
    label: '手动配置',
    iconName: 'file-text',
  },
  manual_ui: {
    bg: 'bg-[var(--semantic-warning-bg)]',
    text: 'text-[var(--semantic-warning-text)]',
    label: '手动配置',
    iconName: 'file-text',
  },
};

export function InstallModeBadge({ mode }: { mode: InstallMode }) {
  const s = MODE_STYLES[mode];
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-caption font-medium ${s.bg} ${s.text}`}>
      <HubIcon name={s.iconName} className="h-3 w-3" />
      {s.label}
    </span>
  );
}
