'use client';

import type { InstallMode, MarketplaceEcosystem, TrustLevel } from '@cat-cafe/shared';
import { HubIcon } from '../hub-icons';

const ECOSYSTEM_STYLES: Record<MarketplaceEcosystem, { bg: string; text: string; label: string }> = {
  claude: { bg: 'bg-purple-50', text: 'text-purple-600 border-purple-300', label: 'Claude' },
  codex: { bg: 'bg-emerald-50', text: 'text-emerald-600 border-emerald-300', label: 'Codex' },
  openclaw: { bg: 'bg-red-50', text: 'text-red-600 border-red-300', label: 'OpenClaw' },
  antigravity: { bg: 'bg-blue-50', text: 'text-blue-600 border-blue-300', label: 'Antigravity' },
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
  official: { bg: 'bg-green-50', text: 'text-green-700', label: 'official', iconName: 'shield' },
  verified: { bg: 'bg-green-50', text: 'text-green-700', label: 'verified', iconName: 'check' },
  community: { bg: 'bg-blue-50', text: 'text-blue-700', label: 'community', iconName: 'users' },
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
  direct_mcp: { bg: 'bg-green-50', text: 'text-green-700', label: '一键安装', iconName: 'zap' },
  delegated_cli: { bg: 'bg-blue-50', text: 'text-blue-700', label: 'CLI 安装', iconName: 'terminal' },
  manual_file: { bg: 'bg-orange-50', text: 'text-orange-700', label: '手动配置', iconName: 'file-text' },
  manual_ui: { bg: 'bg-orange-50', text: 'text-orange-700', label: '手动配置', iconName: 'file-text' },
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
