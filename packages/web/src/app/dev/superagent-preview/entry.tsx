'use client';

import { usePathname } from 'next/navigation';
import { ShellGlyph } from '@/components/shell/ShellIcons';
import { useSuperagentPreview } from './state';

/** Temporary insertion for reviewing the new entry in the actual sidebar. */
export function SuperagentPreviewEntry() {
  const pathname = usePathname();
  const { scene, decision, delivered } = useSuperagentPreview();
  if (process.env.NODE_ENV === 'production' || pathname !== '/dev/superagent-preview') return null;
  if (scene === 'uninstalled') return null;
  const status = { setup: '待设置', active: '监听中', paused: '已暂停', error: '不可用' }[scene];
  const attention = delivered ? 2 : decision ? 0 : scene === 'setup' ? 0 : 1;
  return (
    <div className="mx-2.5 mb-2 rounded-lg bg-[var(--cafe-surface-sunken)]">
      <a
        href="#superagent-conversation"
        aria-current="page"
        className="flex min-h-11 items-center gap-2 px-2.5 text-sm"
      >
        <ShellGlyph name="sparkles" />
        <span className="min-w-0 flex-1 truncate font-medium">我的助手</span>
        {attention > 0 && (
          <span
            role="status"
            className="rounded-md bg-[var(--cafe-accent)] px-1.5 text-xs text-[var(--cafe-accent-foreground)]"
            aria-label={`${attention} 项待处理`}
          >
            {attention}
          </span>
        )}
      </a>
      <p className="pb-2 pl-9 text-xs text-[var(--cafe-text-muted)]">{status}</p>
    </div>
  );
}
