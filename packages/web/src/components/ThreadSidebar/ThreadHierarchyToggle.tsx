/**
 * Expand/collapse toggle for parent threads with child count badge.
 * Renders inline before the thread title in ThreadItem.
 */

interface ThreadHierarchyToggleProps {
  childCount: number;
  isExpanded: boolean;
  onToggle: () => void;
}

export function ThreadHierarchyToggle({ childCount, isExpanded, onToggle }: ThreadHierarchyToggleProps) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="flex items-center gap-1 flex-shrink-0 -ml-0.5 mr-0.5"
      title={isExpanded ? '收起子线程' : '展开子线程'}
    >
      <svg
        aria-hidden="true"
        className={`w-3.5 h-3.5 text-gray-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
        viewBox="0 0 12 12"
        fill="currentColor"
      >
        <path d="M4 2l4 4-4 4V2z" />
      </svg>
      <span
        className={`text-[10px] font-medium px-1.5 py-px rounded-full ${
          isExpanded ? 'bg-purple-100 text-purple-600' : 'bg-gray-100 text-gray-500'
        }`}
      >
        {childCount}
      </span>
    </button>
  );
}
