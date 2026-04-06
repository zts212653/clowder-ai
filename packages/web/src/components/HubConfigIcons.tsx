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
    icon: (
      // eslint-disable-next-line @next/next/no-img-element
      <img src="/images/connectors/feishu.png" alt="Feishu" className="w-[18px] h-[18px]" />
    ),
  },
  telegram: {
    iconBg: '#E0F2FE',
    iconColor: '#0284C7',
    icon: (
      // eslint-disable-next-line @next/next/no-img-element
      <img src="/images/connectors/telegram.png" alt="Telegram" className="w-[18px] h-[18px]" />
    ),
  },
  weixin: {
    iconBg: '#D1FAE5',
    iconColor: '#07C160',
    icon: (
      // eslint-disable-next-line @next/next/no-img-element
      <img src="/images/connectors/weixin.png" alt="WeChat" className="w-[18px] h-[18px]" />
    ),
  },
  dingtalk: {
    iconBg: '#CFFAFE',
    iconColor: '#3296FA',
    icon: (
      // eslint-disable-next-line @next/next/no-img-element
      <img src="/images/connectors/dingtalk.png" alt="DingTalk" className="w-[18px] h-[18px]" />
    ),
  },
  'wecom-bot': {
    iconBg: '#E0E7FF',
    iconColor: '#4F46E5',
    icon: (
      // eslint-disable-next-line @next/next/no-img-element
      <img src="/images/connectors/wecom-bot.png" alt="WeCom" className="w-[18px] h-[18px]" />
    ),
  },
  'wecom-agent': {
    iconBg: '#EDE9FE',
    iconColor: '#7C3AED',
    icon: (
      // eslint-disable-next-line @next/next/no-img-element
      <img src="/images/connectors/wecom-agent.png" alt="WeCom Agent" className="w-[18px] h-[18px]" />
    ),
  },
  xiaoyi: {
    iconBg: '#FEE2E2',
    iconColor: '#E11D48',
    icon: (
      // eslint-disable-next-line @next/next/no-img-element
      <img src="/images/connectors/xiaoyi.png" alt="XiaoYi" className="w-[18px] h-[18px]" />
    ),
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
    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-500 text-white text-[11px] font-bold flex-shrink-0">
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
    <svg className="w-4 h-4 text-amber-600 flex-shrink-0" viewBox="0 0 24 24" stroke="currentColor" {...SVG_PROPS}>
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
