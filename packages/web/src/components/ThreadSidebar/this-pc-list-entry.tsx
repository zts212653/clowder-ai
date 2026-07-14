/**
 * Windows-only directory-list entry for jumping back to the virtual drive root.
 */
import { PcIcon } from './directory-browser-icons';

export function ThisPcListEntry({ onEnterDrivesView }: { onEnterDrivesView: () => void }) {
  return (
    <button
      type="button"
      onClick={onEnterDrivesView}
      className="w-full text-left px-3 py-2.5 text-sm rounded-lg transition-colors flex items-center gap-2.5 hover:bg-cafe-surface/50"
      title="查看所有磁盘"
    >
      <PcIcon />
      <div className="min-w-0 flex-1">
        <span className="font-medium text-cafe-black block truncate">此电脑</span>
        <span className="text-micro text-cafe-muted block truncate">切换磁盘</span>
      </div>
      <svg
        aria-hidden="true"
        className="w-3.5 h-3.5 text-cafe-muted flex-shrink-0"
        viewBox="0 0 20 20"
        fill="currentColor"
      >
        <path
          fillRule="evenodd"
          d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
          clipRule="evenodd"
        />
      </svg>
    </button>
  );
}
