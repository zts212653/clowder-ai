'use client';

import { useChatStore } from '@/stores/chatStore';

/**
 * F226 presentation-surface float toggle — shared by the classic rail and the F322 v2 rail.
 * Present only while a presentation surface exists; it is NOT a fourth permanent entry
 * (home-northstar README §旧入口→新位置: 演示浮窗开关). Collapse/recall must stay reachable from every page.
 */
export function usePresentationRail(): { visible: boolean; minimized: boolean; label: string; onClick: () => void } {
  const surface = useChatStore((s) => s.presentationSurface);
  const minimizeFloat = useChatStore((s) => s.minimizeFloat);
  const minimized = surface?.minimized ?? false;
  return {
    visible: Boolean(surface),
    minimized,
    label: minimized ? '召回演示浮窗（还原讲稿）' : '收起演示浮窗',
    onClick: () => minimizeFloat(!minimized),
  };
}
