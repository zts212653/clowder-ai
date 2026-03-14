'use client';

import type { CatData } from '@/hooks/useCatData';
import { useChatStore } from '@/stores/chatStore';

/** F066: Inline reply quote — shows snippet of the replied-to message */
export function ReplyQuote({
  replyTo,
  getCatById,
}: {
  replyTo: string;
  getCatById: (id: string) => CatData | undefined;
}) {
  const messages = useChatStore((s) => {
    const tid = s.currentThreadId;
    return tid ? s.threadStates[tid]?.messages : undefined;
  });
  const target = messages?.find((m) => m.id === replyTo);
  if (!target) return null;
  const cat = target.catId ? getCatById(target.catId) : undefined;
  const label = cat ? cat.displayName : target.type === 'user' ? 'team lead' : '???';
  const snippet = target.content.length > 80 ? `${target.content.slice(0, 80)}…` : target.content;
  const scrollTo = () => {
    const el = document.querySelector(`[data-message-id="${CSS.escape(replyTo)}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-blue-300');
      setTimeout(() => el.classList.remove('ring-2', 'ring-blue-300'), 1500);
    }
  };
  return (
    <button
      type="button"
      onClick={scrollTo}
      className="flex items-start gap-1.5 text-left w-full mb-2 pl-2 border-l-2 border-gray-300 opacity-70 hover:opacity-100 transition-opacity cursor-pointer"
    >
      <span className="text-xs font-semibold whitespace-nowrap">{label}</span>
      <span className="text-xs text-gray-600 line-clamp-1 break-all">{snippet}</span>
    </button>
  );
}
