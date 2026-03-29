import { useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@/stores/chatStore';

interface A2AGroup {
  groupId: string;
  messages: ChatMessage[];
}

interface A2ACollapsibleProps {
  group: A2AGroup;
  renderMessage: (msg: ChatMessage) => React.ReactNode;
  /** F098: Resolve breed primary color from catId for left border */
  getCatColor?: (catId: string) => string | undefined;
}

/**
 * Collapsible container for A2A (agent-to-agent) chain messages.
 * Shows a summary line when collapsed; expands to show all intermediate messages.
 */
export function A2ACollapsible({ group, renderMessage, getCatColor }: A2ACollapsibleProps) {
  // In export mode (?export=true), default to expanded so screenshots show full A2A conversations
  const isExport =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('export') === 'true';
  const [expanded, setExpanded] = useState(isExport);
  const hasMounted = useRef(false);

  // Cloud P2: local UI toggles can change scrollHeight without scroll/resize events.
  // Emit after DOM commit so scroll-dependent UI (e.g. "↓ 到最新") can recompute.
  useLayoutEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      return;
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('catcafe:chat-layout-changed'));
    }
  }, [expanded]);

  const catIds = [...new Set(group.messages.filter((m) => m.catId).map((m) => m.catId!))];
  const catLabel = catIds.length > 0 ? catIds.join(' ↔ ') : 'agents';
  const count = group.messages.length;

  // F098: Use first cat's breed color for left border (instead of static purple)
  const firstCatId = group.messages[0]?.catId;
  const borderColor = (firstCatId && getCatColor?.(firstCatId)) ?? '#9B7EBD';

  return (
    <div className="my-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 text-sm text-cafe-secondary hover:text-cafe-secondary dark:text-gray-400 dark:hover:text-gray-200 transition-colors px-3 py-1.5 rounded-md hover:bg-cafe-surface-elevated dark:hover:bg-gray-800"
      >
        <span
          className="inline-block transition-transform duration-200"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          ▶
        </span>
        <span>
          {expanded ? '收起内部讨论' : `查看内部讨论`} ({catLabel}, {count} 条)
        </span>
      </button>

      {expanded && (
        <div
          className="mt-1 ml-3 pl-3 border-l-2 space-y-1 bg-slate-50 dark:bg-slate-800/50 rounded-r-lg py-2"
          style={{ borderColor }}
        >
          {group.messages.map((msg) => (
            <div key={msg.id}>{renderMessage(msg)}</div>
          ))}
        </div>
      )}
    </div>
  );
}
