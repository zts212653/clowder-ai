import Link from 'next/link';
import { messageFindReturnHref } from '@/components/message-search/message-find-events';
import { ShellGlyph } from '@/components/shell/ShellIcons';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { useSidebarStore } from '@/stores/sidebarStore';

/** The page keeps its way out even after the user collapses the Café sidebar. */
export function MemoryNavigation({ from, findSessionId }: { from?: string | null; findSessionId?: string | null }) {
  const { isOpen, open } = useSidebarStore();
  const isDesktop = useIsDesktop();
  const findReturn = messageFindReturnHref(findSessionId, from);
  return (
    <div className="flex items-center gap-2">
      {isDesktop && !isOpen && (
        <button
          type="button"
          aria-label="展开侧栏"
          data-testid="memory-sidebar-expand"
          onClick={open}
          className="shell-rail-item shell-focusable flex h-8 w-8 items-center justify-center rounded-lg"
        >
          <ShellGlyph name="panelLeft" />
        </button>
      )}
      <Link
        href={findReturn ?? (from ? `/thread/${encodeURIComponent(from)}` : '/')}
        aria-label={findReturn ? '‹ 回到查找' : from ? '返回原对话' : '返回对话'}
        className="whitespace-nowrap rounded-lg px-2 py-2 text-compact text-cafe-muted hover:bg-cafe-surface-sunken"
      >
        {findReturn ? '‹ 回到查找' : '返回对话'}
      </Link>
    </div>
  );
}
