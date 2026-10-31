import { AppTooltip } from '../AppTooltip';
import { ShellGlyph } from '../shell/ShellIcons';

export function MessageSearchButton({ onOpen, open = false }: { onOpen: () => void; open?: boolean }) {
  return (
    <AppTooltip label="查找消息" side="bottom">
      <button
        type="button"
        onClick={onOpen}
        aria-label="查找消息"
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="message-search-entry"
        className="shell-focusable flex h-8 w-8 flex-none items-center justify-center rounded-lg text-cafe-secondary hover:bg-[var(--console-hover-bg)] hover:text-cafe-accent"
      >
        <ShellGlyph name="search" />
      </button>
    </AppTooltip>
  );
}
