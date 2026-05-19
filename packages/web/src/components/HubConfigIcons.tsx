import Image from 'next/image';
import type { ReactNode } from 'react';

// ── Per-platform visual config (matches .pen wireframe Screen C) ──

export interface PlatformVisual {
  iconBg: string;
  iconColor: string;
  icon: ReactNode;
}

const SVG_PROPS = {
  fill: 'none' as const,
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const PLATFORM_VISUALS: Record<string, PlatformVisual> = {
  feishu: {
    iconBg: '#DBEAFE',
    iconColor: '#2563EB',
    icon: <Image src="/images/connectors/feishu.png" alt="Feishu" width={18} height={18} />,
  },
  telegram: {
    iconBg: '#E0F2FE',
    iconColor: '#0284C7',
    icon: <Image src="/images/connectors/telegram.png" alt="Telegram" width={18} height={18} />,
  },
  weixin: {
    iconBg: '#D1FAE5',
    iconColor: '#07C160',
    icon: <Image src="/images/connectors/weixin.png" alt="WeChat" width={18} height={18} />,
  },
  dingtalk: {
    iconBg: '#CFFAFE',
    iconColor: '#3296FA',
    icon: <Image src="/images/connectors/dingtalk.png" alt="DingTalk" width={18} height={18} />,
  },
  'wecom-bot': {
    iconBg: '#E0E7FF',
    iconColor: '#4F46E5',
    icon: <Image src="/images/connectors/wecom-bot.png" alt="WeCom" width={18} height={18} />,
  },
  'wecom-agent': {
    iconBg: '#EDE9FE',
    iconColor: '#7C3AED',
    icon: <Image src="/images/connectors/wecom-agent.png" alt="WeCom Agent" width={18} height={18} />,
  },
  xiaoyi: {
    iconBg: '#FEE2E2',
    iconColor: '#E11D48',
    icon: <Image src="/images/connectors/xiaoyi.png" alt="XiaoYi" width={18} height={18} />,
  },
};

export const DEFAULT_VISUAL: PlatformVisual = {
  iconBg: '#F3F4F6',
  iconColor: '#6B7280',
  icon: (
    <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" stroke="currentColor" {...SVG_PROPS}>
      <path d="M12 12m-10 0a10 10 0 1 0 20 0a10 10 0 1 0-20 0" />
    </svg>
  ),
};

export function StepBadge({ num }: { num: number }) {
  return (
    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-conn-blue-text text-white text-xs font-bold flex-shrink-0">
      {num}
    </span>
  );
}

export function ChevronRight() {
  return (
    <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" stroke="currentColor" {...SVG_PROPS}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

export function ChevronDown() {
  return (
    <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" stroke="currentColor" {...SVG_PROPS}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function ExternalLinkIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" stroke="currentColor" {...SVG_PROPS}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

export function WifiIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-cafe-secondary" viewBox="0 0 24 24" stroke="currentColor" {...SVG_PROPS}>
      <path d="M5 13a10 10 0 0 1 14 0" />
      <path d="M8.5 16.5a5 5 0 0 1 7 0" />
      <path d="M2 8.82a15 15 0 0 1 20 0" />
      <line x1="12" x2="12.01" y1="20" y2="20" />
    </svg>
  );
}

export function TriangleAlertIcon() {
  return (
    <svg
      className="w-4 h-4 text-conn-amber-text flex-shrink-0"
      viewBox="0 0 24 24"
      stroke="currentColor"
      {...SVG_PROPS}
    >
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/** Solid green circle — "configured / connected" status indicator */
export function StatusDotConnected() {
  return (
    <svg className="w-2.5 h-2.5 flex-shrink-0" viewBox="0 0 10 10">
      <circle cx="5" cy="5" r="5" fill="#16A34A" />
    </svg>
  );
}

/** Hollow gray circle — "not configured" status indicator */
export function StatusDotIdle() {
  return (
    <svg className="w-2.5 h-2.5 flex-shrink-0" viewBox="0 0 10 10">
      <circle cx="5" cy="5" r="4" fill="none" stroke="#9CA3AF" strokeWidth="2" />
    </svg>
  );
}

/** QR code icon for the "generate QR" button */
export function QrCodeIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" stroke="currentColor" {...SVG_PROPS}>
      <rect width="6" height="6" x="3" y="3" rx="1" />
      <rect width="6" height="6" x="15" y="3" rx="1" />
      <rect width="6" height="6" x="3" y="15" rx="1" />
      <path d="M15 15h2v2" />
      <path d="M21 15h-2v6h6v-2" />
      <path d="M15 21v-2" />
    </svg>
  );
}

/** Spinning loader indicator */
export function SpinnerIcon() {
  return (
    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** Checkmark circle icon for success states */
export function CheckCircleIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" stroke="currentColor" {...SVG_PROPS}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="m9 11 3 3L22 4" />
    </svg>
  );
}

export function LockIcon() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 24 24" stroke="currentColor" {...SVG_PROPS}>
      <rect width="18" height="11" x="3" y="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

// ── Connector config types & helpers ──

export interface PlatformFieldStatus {
  envName: string;
  label: string;
  sensitive: boolean;
  currentValue: string | null;
}

export interface PlatformStepStatus {
  text: string;
  mode?: string;
}

export interface PlatformStatus {
  id: string;
  name: string;
  nameEn: string;
  category?: 'im' | 'plugin';
  configured: boolean;
  connectionState?: 'connected' | 'disconnected' | 'reconnecting' | 'unknown';
  lastHeartbeat?: number | null;
  fields: PlatformFieldStatus[];
  docsUrl: string;
  steps: PlatformStepStatus[];
}

export const PERMISSION_CONNECTORS: Record<string, string> = {
  feishu: '飞书',
  'wecom-bot': '企业微信',
  dingtalk: '钉钉',
};

export function connStatePill(p: PlatformStatus): { label: string; className: string } {
  if (p.connectionState === 'connected')
    return { label: '已连接', className: 'bg-conn-emerald-bg text-conn-emerald-text' };
  if (p.connectionState === 'reconnecting')
    return { label: '重连中', className: 'bg-conn-amber-bg text-conn-amber-text' };
  if (p.connectionState === 'disconnected' && p.configured)
    return { label: '已配置', className: 'bg-conn-amber-bg text-conn-amber-text' };
  if (p.configured) return { label: '已配置', className: 'bg-conn-amber-bg text-conn-amber-text' };
  return { label: '未配置', className: 'bg-cafe-surface-sunken text-cafe-muted' };
}

export function formatHeartbeat(ts: number): string {
  const ago = Math.floor((Date.now() - ts) / 1000);
  if (ago < 60) return `${ago}s ago`;
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
  return `${Math.floor(ago / 3600)}h ago`;
}
